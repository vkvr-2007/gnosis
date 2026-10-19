package com.gnosis.phone;

import android.content.Context;
import android.content.SharedPreferences;

/** What the app remembers: the laptop's address, its key from pairing, and a code waiting to be used. */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("gnosis", Context.MODE_PRIVATE);
    }

    static String host(Context c) { return p(c).getString("host", ""); }
    static String token(Context c) { return p(c).getString("token", ""); }
    static String pendingCode(Context c) { return p(c).getString("code", ""); }

    static void pairWith(Context c, String host, String code) {
        p(c).edit().putString("host", host.trim()).putString("code", code.trim()).remove("token").apply();
    }

    static void paired(Context c, String token) {
        p(c).edit().putString("token", token).remove("code").apply();
    }

    static void forget(Context c) {
        p(c).edit().remove("token").remove("code").apply();
    }

    static boolean canConnect(Context c) {
        return !host(c).isEmpty() && (!token(c).isEmpty() || !pendingCode(c).isEmpty());
    }
}
