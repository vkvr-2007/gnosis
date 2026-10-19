package com.gnosis.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reconnects to Gnosis after the phone restarts, once it has been paired. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !Prefs.token(context).isEmpty()) {
            LinkService.start(context);
        }
    }
}
