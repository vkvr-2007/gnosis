package com.gnosis.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The phone's link to Gnosis on the laptop: one WebSocket to ws://<laptop>:8790/link, kept open by a
 * foreground service and reopened with a growing pause when Wi-Fi drops. The first time it trades the
 * pairing code for the app's own key; after that it says hello with the key. Commands from the laptop
 * run one at a time, off the network thread; the phone's notifications and the owner's questions go
 * the other way.
 */
public class LinkService extends Service {
    /** What the screen shows: the link's state, and Gnosis's answers. */
    interface Listener {
        void onStatus(String status);
        void onAnswer(String id, String text, boolean done);
    }

    private static final String CHANNEL_LINK = "link";
    private static final String CHANNEL_NOTICE = "notice";
    private static volatile LinkService instance;
    private static volatile Listener listener;
    private static volatile String status = "Not connected";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService commands = Executors.newSingleThreadExecutor();
    private volatile OkHttpClient http;
    private volatile WebSocket socket;
    private volatile boolean ready;
    private boolean stopped;
    private long retryMs = 2000;
    private int noticeId = 100;

    static void start(Context c) {
        Intent i = new Intent(c, LinkService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, LinkService.class));
    }

    static void listen(Listener l) {
        listener = l;
        if (l != null) l.onStatus(status);
    }

    static String status() {
        return status;
    }

    /** A question typed or said on the phone, for Gnosis. */
    static boolean ask(String id, String text) {
        LinkService s = instance;
        return s != null && s.send(json("type", "ask", "id", id, "text", text));
    }

    static void sendNotification(JSONObject n) {
        LinkService s = instance;
        if (s == null) return;
        try {
            JSONObject o = new JSONObject(n.toString());
            o.put("type", "notification");
            s.send(o);
        } catch (Exception ignored) {
            // Left out.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_LINK, "Connection to Gnosis", NotificationManager.IMPORTANCE_MIN));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_NOTICE, "Reminders and notices", NotificationManager.IMPORTANCE_HIGH));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new Notification.Builder(this, CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Gnosis")
            .setContentText("Connected to your laptop while this is on")
            .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(1, n);
        stopped = false;
        // The network client is built off the main thread: Android gives a service a few seconds to show its
        // notification, and building it first ran past that on a slow phone (ANR in the emulator, 2026-10-19).
        commands.execute(() -> {
            if (http == null) http = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).retryOnConnectionFailure(true).build();
            main.post(this::connect);
        });
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        instance = null;
        if (socket != null) socket.close(1000, "closed");
        commands.shutdownNow();
        setStatus("Not connected");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void connect() {
        if (stopped || socket != null || http == null) return;
        String host = Prefs.host(this);
        if (!Prefs.canConnect(this)) {
            setStatus("Not paired. Scan the QR code from Gnosis on your laptop.");
            return;
        }
        setStatus("Connecting to " + host + "…");
        Request req = new Request.Builder().url("ws://" + host + "/link").build();
        socket = http.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                String token = Prefs.token(LinkService.this);
                String model = Build.MANUFACTURER + " " + Build.MODEL;
                if (!token.isEmpty()) ws.send(json("type", "hello", "token", token, "model", model).toString());
                else ws.send(json("type", "pair", "code", Prefs.pendingCode(LinkService.this), "name", Build.MODEL, "model", model).toString());
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                try {
                    handle(new JSONObject(text));
                } catch (Exception ignored) {
                    // Not a message of ours.
                }
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                dropped(ws, code == 4003 ? null : "Disconnected");
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                dropped(ws, "Can't reach Gnosis at " + Prefs.host(LinkService.this) + ". Same Wi-Fi as the laptop?");
            }
        });
    }

    /** The link closed: try again after a growing pause, unless Gnosis said this phone isn't paired. */
    private void dropped(WebSocket ws, String why) {
        main.post(() -> {
            if (socket != ws) return;
            socket = null;
            ready = false;
            if (why == null || stopped) return;
            setStatus(why + " Trying again in " + retryMs / 1000 + " s.");
            main.postDelayed(this::connect, retryMs);
            retryMs = Math.min(retryMs * 2, 60_000);
        });
    }

    private void handle(JSONObject m) {
        switch (m.optString("type")) {
            case "paired":
                Prefs.paired(this, m.optString("token"));
                // fall through: paired means connected
            case "welcome":
                ready = true;
                retryMs = 2000;
                setStatus("Connected to Gnosis");
                break;
            case "denied":
                Prefs.forget(this);
                setStatus(m.optString("reason", "Gnosis didn't accept this phone.") + " Scan a new QR code from Gnosis.");
                break;
            case "command":
                String id = m.optString("id");
                String op = m.optString("op");
                JSONObject args = m.optJSONObject("args");
                commands.execute(() -> runCommand(id, op, args == null ? new JSONObject() : args));
                break;
            case "answer":
                Listener l = listener;
                String answerId = m.optString("id");
                String text = m.optString("text");
                boolean done = m.optBoolean("done");
                if (l != null) main.post(() -> l.onAnswer(answerId, text, done));
                break;
            case "notice":
                showNotice(m.optString("text"));
                break;
            default:
                break;
        }
    }

    private void runCommand(String id, String op, JSONObject args) {
        JSONObject reply = json("type", "result", "id", id);
        try {
            Object data = new Phone(this).run(op, args);
            reply.put("ok", true);
            reply.put("data", data);
        } catch (Exception e) {
            try {
                reply.put("ok", false);
                reply.put("error", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception ignored) {
                // Unreachable for plain strings.
            }
        }
        send(reply);
    }

    private void showNotice(String text) {
        if (text.isEmpty()) return;
        Notification n = new Notification.Builder(this, CHANNEL_NOTICE)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Gnosis")
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .build();
        getSystemService(NotificationManager.class).notify(noticeId++, n);
    }

    private boolean send(JSONObject o) {
        WebSocket ws = socket;
        return ws != null && ready && ws.send(o.toString());
    }

    private void setStatus(String s) {
        status = s;
        Listener l = listener;
        if (l != null) main.post(() -> l.onStatus(s));
    }

    static JSONObject json(String... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(kv[i], kv[i + 1]);
        } catch (Exception ignored) {
            // Plain strings always fit.
        }
        return o;
    }
}
