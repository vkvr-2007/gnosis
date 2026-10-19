package com.gnosis.phone;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * What Gnosis can ask the phone to do (a "command" from the laptop). Each returns its result as JSON
 * or throws with a sentence the owner can act on. Calling and sending were approved by the owner on
 * the laptop before the command was sent.
 */
final class Phone {
    private final Context ctx;

    Phone(Context ctx) {
        this.ctx = ctx;
    }

    Object run(String op, JSONObject args) throws Exception {
        switch (op) {
            case "status": return status();
            case "call": return call(args.getString("number"));
            case "hang_up": return hangUp();
            case "sms": return sms(args.getString("number"), args.getString("text"));
            case "whatsapp": return whatsapp(args.getString("number"), args.getString("text"));
            case "open_app": return openApp(args.getString("name"));
            case "contacts": return contacts();
            case "notifications": return NotificationWatcher.recent();
            default: throw new Exception("The app doesn't know \"" + op + "\" yet. Update the Gnosis app.");
        }
    }

    private void need(String permission, String what) throws Exception {
        if (ctx.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            throw new Exception("The Gnosis app isn't allowed to " + what + " yet. Open the app on the phone and tap Allow.");
        }
    }

    private JSONObject status() throws Exception {
        BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
        JSONObject o = new JSONObject();
        o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        o.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
        o.put("charging", bm.isCharging());
        return o;
    }

    private JSONObject call(String number) throws Exception {
        need(Manifest.permission.CALL_PHONE, "make calls");
        TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
        tm.placeCall(Uri.fromParts("tel", number, null), new Bundle());
        return new JSONObject().put("calling", number);
    }

    @SuppressWarnings("deprecation")
    private JSONObject hangUp() throws Exception {
        need(Manifest.permission.ANSWER_PHONE_CALLS, "end calls");
        TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
        return new JSONObject().put("ended", tm.endCall());
    }

    @SuppressWarnings("deprecation")
    private JSONObject sms(String number, String text) throws Exception {
        need(Manifest.permission.SEND_SMS, "send texts");
        SmsManager sm = Build.VERSION.SDK_INT >= 31 ? ctx.getSystemService(SmsManager.class) : SmsManager.getDefault();
        ArrayList<String> parts = sm.divideMessage(text);
        sm.sendMultipartTextMessage(number, null, parts, null, null);
        return new JSONObject().put("sent", true);
    }

    /** Opens the chat with the text in it; the send helper presses Send if the owner turned it on. */
    private JSONObject whatsapp(String number, String text) throws Exception {
        canOpenApps();
        String url = "https://wa.me/" + number + "?text=" + Uri.encode(text);
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String pkg = installed("com.whatsapp") ? "com.whatsapp" : installed("com.whatsapp.w4b") ? "com.whatsapp.w4b" : null;
        if (pkg == null) throw new Exception("WhatsApp isn't installed on the phone.");
        i.setPackage(pkg);
        boolean helper = SendHelper.enabled();
        CountDownLatch sent = new CountDownLatch(1);
        if (helper) SendHelper.arm(sent::countDown);
        ctx.startActivity(i);
        boolean ok = helper && sent.await(12, TimeUnit.SECONDS);
        if (!ok) SendHelper.disarm();
        return new JSONObject().put("sent", ok).put("helper", helper);
    }

    private JSONObject openApp(String name) throws Exception {
        canOpenApps();
        PackageManager pm = ctx.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(launcher, 0);
        String want = name.toLowerCase(Locale.ROOT).trim();
        ResolveInfo best = null;
        for (ResolveInfo r : apps) {
            String label = String.valueOf(r.loadLabel(pm)).toLowerCase(Locale.ROOT);
            if (label.equals(want)) { best = r; break; }
            if (best == null && (label.contains(want) || r.activityInfo.packageName.toLowerCase(Locale.ROOT).contains(want.replace(" ", "")))) best = r;
        }
        if (best == null) throw new Exception("There's no app called \"" + name + "\" on the phone.");
        Intent open = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
        if (open == null) throw new Exception("That app can't be opened this way.");
        ctx.startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        return new JSONObject().put("label", String.valueOf(best.loadLabel(pm)));
    }

    private JSONArray contacts() throws Exception {
        need(Manifest.permission.READ_CONTACTS, "read contacts");
        JSONArray out = new JSONArray();
        ContentResolver cr = ctx.getContentResolver();
        String[] cols = {ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER};
        try (Cursor c = cr.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String name = c.getString(0);
                String number = c.getString(1);
                if (name != null && number != null) out.put(new JSONObject().put("name", name).put("number", number));
            }
        }
        return out;
    }

    /** Android only lets an app open other apps from the background with "Display over other apps". */
    private void canOpenApps() throws Exception {
        if (!Settings.canDrawOverlays(ctx)) {
            throw new Exception("The Gnosis app needs \"Display over other apps\" to open apps for you. Open the app on the phone and allow it.");
        }
    }

    private boolean installed(String pkg) {
        try {
            ctx.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}
