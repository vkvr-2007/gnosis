package com.gnosis.phone;

import android.accessibilityservice.AccessibilityService;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/**
 * Gnosis send helper (an accessibility service the owner turns on): presses WhatsApp's Send button,
 * and only for a few seconds after Gnosis opened a chat for a message the owner approved on the
 * laptop. Outside that moment it does nothing and reads nothing.
 */
public class SendHelper extends AccessibilityService {
    private static volatile SendHelper running;
    private static volatile long armedUntil;
    private static volatile Runnable onSent;

    static boolean enabled() {
        return running != null;
    }

    /** Press Send in WhatsApp once, within the next few seconds; then call back. */
    static void arm(Runnable sent) {
        onSent = sent;
        armedUntil = SystemClock.uptimeMillis() + 12_000;
    }

    static void disarm() {
        armedUntil = 0;
        onSent = null;
    }

    @Override
    protected void onServiceConnected() {
        running = this;
    }

    @Override
    public void onDestroy() {
        running = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (SystemClock.uptimeMillis() > armedUntil) return;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null || !root.getPackageName().toString().startsWith("com.whatsapp")) return;
        for (String id : new String[] {"com.whatsapp:id/send", "com.whatsapp.w4b:id/send"}) {
            List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(id);
            for (AccessibilityNodeInfo node : found) {
                if (node.isEnabled() && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    Runnable done = onSent;
                    disarm();
                    if (done != null) done.run();
                    return;
                }
            }
        }
    }

    @Override
    public void onInterrupt() {}
}
