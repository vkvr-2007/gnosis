package com.gnosis.phone;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * The phone's notifications, for Gnosis: each new one is passed on to the laptop as it arrives, and
 * the latest few are kept for "what are my notifications?". Only works once the owner has given
 * Gnosis notification access (Settings, from the app's own button).
 */
public class NotificationWatcher extends NotificationListenerService {
    private static final ArrayDeque<JSONObject> RECENT = new ArrayDeque<>();
    private static final int KEEP = 40;

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null || getPackageName().equals(sbn.getPackageName())) return;
        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0 || sbn.isOngoing()) return;
        Bundle extras = n.extras;
        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        String body = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (body.isEmpty()) body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
        if (title.isEmpty() && body.isEmpty()) return;
        try {
            JSONObject o = new JSONObject();
            o.put("app", label(sbn.getPackageName()));
            o.put("title", title);
            o.put("text", body);
            o.put("at", sbn.getPostTime());
            synchronized (RECENT) {
                RECENT.addFirst(o);
                while (RECENT.size() > KEEP) RECENT.removeLast();
            }
            LinkService.sendNotification(o);
        } catch (Exception ignored) {
            // A notification that can't be read is left out.
        }
    }

    /** The latest notifications, newest first. */
    static JSONArray recent() {
        JSONArray a = new JSONArray();
        synchronized (RECENT) {
            Iterator<JSONObject> it = RECENT.iterator();
            while (it.hasNext()) a.put(it.next());
        }
        return a;
    }

    private String label(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(info));
        } catch (Exception e) {
            return pkg;
        }
    }

    private static String text(CharSequence s) {
        return s == null ? "" : s.toString().trim();
    }
}
