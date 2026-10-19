package com.gnosis.phone;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The app's one screen: whether it's connected to Gnosis, pairing (from the setup page's link, or the
 * address and code typed in), the permissions Gnosis needs on the phone, and a box to ask Gnosis
 * something from the phone (typed or spoken; the answer is shown and read out).
 */
public class MainActivity extends Activity implements LinkService.Listener {
    private static final int BG = Color.parseColor("#161514");
    private static final int CARD = Color.parseColor("#22201E");
    private static final int INK = Color.parseColor("#EDEAE6");
    private static final int DIM = Color.parseColor("#A39E98");
    private static final int AMBER = Color.parseColor("#EF9A4C");
    private static final int SPEAK = 7;

    private TextView status;
    private LinearLayout pairBox;
    private TextView pairedLine;
    private EditText address;
    private EditText code;
    private LinearLayout perms;
    private EditText question;
    private TextView answer;
    private TextToSpeech tts;
    private String asking = "";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        setContentView(build());
        tts = new TextToSpeech(this, s -> {
            if (s == TextToSpeech.SUCCESS) tts.setLanguage(new Locale("en", "IN"));
        });
        fromLink(getIntent());
        if (Prefs.canConnect(this)) LinkService.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        fromLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        LinkService.listen(this);
        refresh();
    }

    @Override
    protected void onPause() {
        LinkService.listen(null);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    /** gnosis://pair?host=192.168.1.5:8790&code=123456, from the setup page Gnosis showed. */
    private void fromLink(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"gnosis".equals(data.getScheme())) return;
        String host = data.getQueryParameter("host");
        String c = data.getQueryParameter("code");
        if (host != null && c != null) pair(host, c);
    }

    private void pair(String host, String c) {
        Prefs.pairWith(this, host, c);
        LinkService.stop(this);
        LinkService.start(this);
        refresh();
    }

    // ---- what the link says ---------------------------------------------------------------

    @Override
    public void onStatus(String s) {
        status.setText(s);
        status.setTextColor(s.startsWith("Connected") ? AMBER : DIM);
        refresh();
    }

    @Override
    public void onAnswer(String id, String text, boolean done) {
        if (!id.equals(asking)) return;
        answer.setText(text);
        if (done && !text.isEmpty()) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
    }

    // ---- the screen ---------------------------------------------------------------------------

    private View build() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(20), dp(28), dp(20), dp(28));

        TextView title = text("Gnosis", 30, INK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        status = text(LinkService.status(), 15, DIM);
        col.addView(status, margins(0, 4, 0, 16));

        // Asking Gnosis from the phone.
        LinearLayout ask = card(col, "Ask Gnosis");
        question = new EditText(this);
        question.setHint("Ask anything…");
        question.setTextColor(INK);
        question.setHintTextColor(DIM);
        question.setImeOptions(EditorInfo.IME_ACTION_SEND);
        question.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        question.setOnEditorActionListener((v, a, e) -> {
            send();
            return true;
        });
        ask.addView(question);
        LinearLayout row = new LinearLayout(this);
        row.addView(button("Ask", true, v -> send()), weight());
        row.addView(button("Speak", false, v -> listen()), weight());
        ask.addView(row);
        answer = text("", 16, INK);
        ask.addView(answer, margins(0, 10, 0, 0));

        // Pairing.
        pairBox = card(col, "Connect to your laptop");
        pairBox.addView(text("Scan the QR code Gnosis shows on your laptop and tap \"Open Gnosis and connect\", or type what it says:", 14, DIM));
        address = field("Address, like 192.168.1.5:8790", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(Prefs.host(this));
        pairBox.addView(address);
        code = field("Six-digit code", InputType.TYPE_CLASS_NUMBER);
        pairBox.addView(code);
        pairBox.addView(button("Connect", true, v -> {
            String a = address.getText().toString().trim();
            String c = code.getText().toString().trim();
            if (!a.isEmpty() && c.length() == 6) pair(a.contains(":") ? a : a + ":8790", c);
            else status.setText("Type the address and the six-digit code from Gnosis.");
        }));
        pairedLine = text("", 14, DIM);
        col.addView(pairedLine, margins(4, 0, 4, 12));

        // Permissions.
        LinearLayout p = card(col, "What Gnosis can do on this phone");
        perms = new LinearLayout(this);
        perms.setOrientation(LinearLayout.VERTICAL);
        p.addView(perms);

        Button forget = button("Unpair this phone", false, v -> {
            Prefs.forget(this);
            LinkService.stop(this);
            status.setText("Not paired.");
            refresh();
        });
        col.addView(forget, margins(0, 8, 0, 0));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.addView(col);
        return scroll;
    }

    /** Shows pairing only when needed, and each permission with whether it's on. */
    private void refresh() {
        if (perms == null) return;
        boolean paired = !Prefs.token(this).isEmpty();
        pairBox.setVisibility(paired ? View.GONE : View.VISIBLE);
        pairedLine.setText(paired ? "Paired with Gnosis at " + Prefs.host(this) : "");
        perms.removeAllViews();
        String[] runtime = runtimePermissions();
        boolean granted = true;
        for (String r : runtime) granted &= checkSelfPermission(r) == PackageManager.PERMISSION_GRANTED;
        perm("Calls, texts and contacts", granted, () -> requestPermissions(runtime, 1));
        perm("Read notifications", notificationAccess(), () -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        perm("Open apps for you (display over other apps)", Settings.canDrawOverlays(this),
            () -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))));
        perm("Press Send in WhatsApp (Gnosis send helper)", SendHelper.enabled(),
            () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        PowerManager pm = getSystemService(PowerManager.class);
        perm("Stay connected in the background", pm.isIgnoringBatteryOptimizations(getPackageName()),
            () -> startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))));
    }

    private String[] runtimePermissions() {
        List<String> list = new ArrayList<>();
        list.add(Manifest.permission.CALL_PHONE);
        list.add(Manifest.permission.SEND_SMS);
        list.add(Manifest.permission.READ_CONTACTS);
        if (Build.VERSION.SDK_INT >= 28) list.add(Manifest.permission.ANSWER_PHONE_CALLS);
        if (Build.VERSION.SDK_INT >= 33) list.add(Manifest.permission.POST_NOTIFICATIONS);
        return list.toArray(new String[0]);
    }

    private boolean notificationAccess() {
        String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(new ComponentName(this, NotificationWatcher.class).flattenToString());
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        refresh();
    }

    private void perm(String what, boolean on, Runnable allow) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = text((on ? "✓  " : "•  ") + what, 15, on ? INK : DIM);
        row.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        if (!on) row.addView(button("Allow", false, v -> allow.run()));
        perms.addView(row, margins(0, 4, 0, 4));
    }

    // ---- asking ----------------------------------------------------------------------------------

    private void send() {
        String q = question.getText().toString().trim();
        if (q.isEmpty()) return;
        asking = "a" + System.currentTimeMillis();
        if (LinkService.ask(asking, q)) {
            answer.setText("…");
            question.setText("");
        } else {
            answer.setText("Not connected to Gnosis right now.");
        }
    }

    private void listen() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Ask Gnosis");
        try {
            startActivityForResult(i, SPEAK);
        } catch (Exception e) {
            answer.setText("This phone has no speech input. Type the question instead.");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SPEAK || resultCode != RESULT_OK || data == null) return;
        ArrayList<String> said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (said != null && !said.isEmpty()) {
            question.setText(said.get(0));
            send();
        }
    }

    // ---- small builders ----------------------------------------------------------------------

    private LinearLayout card(LinearLayout parent, String heading) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(CARD);
        bg.setCornerRadius(dp(14));
        c.setBackground(bg);
        TextView h = text(heading, 17, INK);
        h.setTypeface(Typeface.DEFAULT_BOLD);
        c.addView(h, margins(0, 0, 0, 6));
        parent.addView(c, margins(0, 0, 0, 14));
        return c;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private EditText field(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(type);
        e.setTextColor(INK);
        e.setHintTextColor(DIM);
        return e;
    }

    private Button button(String label, boolean primary, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? BG : AMBER);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(10));
        if (primary) bg.setColor(AMBER); else bg.setStroke(dp(1), AMBER);
        b.setBackground(bg);
        b.setOnClickListener(click);
        return b;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        lp.setMargins(dp(4), dp(6), dp(4), 0);
        return lp;
    }

    private LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(l), dp(t), dp(r), dp(b));
        return lp;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
