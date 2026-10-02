package fr.soaresden.msczplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Vérifie en arrière-plan (toutes les ~30 min, avec réseau) si la prof a envoyé de nouvelles annotations
 * dans le dossier pCloud partagé, et affiche une notification Android.
 */
public class GuestCheckJob extends JobService {
    static final int JOB_ID = 7301;
    static final String CHANNEL = "guest";

    static void schedule(Context ctx, boolean on) {
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        if (!on) { js.cancel(JOB_ID); return; }
        for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB_ID) return;
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, GuestCheckJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(30 * 60 * 1000L)
                .setPersisted(true)
                .build();
        js.schedule(info);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try { check(getApplicationContext()); } catch (Throwable ignored) { }
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return true; }

    static void check(Context ctx) throws Exception {
        SharedPreferences sp = ctx.getSharedPreferences("mcsz", Context.MODE_PRIVATE);
        String cfg = sp.getString("share", "");
        if (cfg.isEmpty()) return;
        JSONObject c = new JSONObject(cfg);
        String link = c.optString("link"), pwd = c.optString("pwd"), guest = c.optString("guest", "Prof");
        Matcher m = Pattern.compile("code=([A-Za-z0-9]+)").matcher(link);
        if (!m.find()) return;
        String api = link.contains("u.pcloud.link") ? "https://api.pcloud.com" : "https://eapi.pcloud.com";
        String url = api + "/showpublink?code=" + m.group(1) + "&linkpassword=" + URLEncoder.encode(pwd, "UTF-8");
        JSONObject res = new JSONObject(get(url));
        if (res.optInt("result", -1) != 0) return;
        // derniers envois de la prof : « <Prof> - <partition>.mscz - AAAAMMJJ-HHMMSS.json »
        Pattern p = Pattern.compile("^(.+?) - (.+\\.(?:mscz|mscx)|!Agenda|!Avis) - (\\d{8}-\\d{6})(?: ?\\(\\d+\\))?\\.json$", Pattern.CASE_INSENSITIVE);
        Map<String, String> latest = new HashMap<>();
        walk(res.getJSONObject("metadata"), p, latest, 0);
        // partitions envoyées par la prof (dossiers « Files from <Prof> on … »)
        try {
            List<String[]> sc = new ArrayList<>();
            walkScores(res.getJSONObject("metadata"), sc, 0);
            JSONObject done = new JSONObject(sp.getString("scoreNotified", "{}"));
            List<String> names = new ArrayList<>(); java.util.Set<String> from = new java.util.LinkedHashSet<>();
            for (String[] x : sc) if (!done.has(x[0])) { done.put(x[0], 1); names.add(x[1].replaceAll("(?i)\\.(mscz|mscx)$", "")); from.add(x[2]); }
            if (!names.isEmpty()) {
                sp.edit().putString("scoreNotified", done.toString()).apply();
                notify(ctx, String.join(", ", from) + (names.size() > 1 ? " t'a envoyé " + names.size() + " partitions" : " t'a envoyé une partition"), String.join(", ", names));
            }
        } catch (Exception ignored) { }
        JSONObject seen = new JSONObject(sp.getString("guestSeen", "{}"));
        JSONObject notified = new JSONObject(sp.getString("guestNotified", "{}"));
        List<String> fresh = new ArrayList<>();
        java.util.Set<String> who = new java.util.LinkedHashSet<>();
        for (Map.Entry<String, String> e : latest.entrySet()) {
            String doc = e.getKey(), st = e.getValue().substring(0, 15);
            String by = e.getValue().substring(16);
            if (st.compareTo(seen.optString(doc, "")) > 0 && st.compareTo(notified.optString(doc, "")) > 0) { fresh.add(doc); who.add(by); }
        }
        // agenda des cours (« <Prof> - !Cours.mscz - … ») : notification à part
        for (java.util.Iterator<String> it = fresh.iterator(); it.hasNext(); ) {
            String d = it.next();
            if (d.startsWith("!Avis")) { it.remove(); notified.put(d, latest.get(d).substring(0, 15)); sp.edit().putString("guestNotified", notified.toString()).apply(); notify(ctx, latest.get(d).substring(16) + " t'a répondu", "Ta demande d'avis a une réponse — ouvre Partoche"); continue; }
            if (d.startsWith("!Cours") || d.startsWith("!Agenda")) { it.remove(); notified.put(d, latest.get(d).substring(0, 15)); sp.edit().putString("guestNotified", notified.toString()).apply(); notify(ctx, latest.get(d).substring(16) + " : agenda des cours", "Nouvelle demande ou réponse pour un cours — ouvre Partoche"); }
        }
        who.clear(); for (String d : fresh) who.add(latest.get(d).substring(16));
        if (fresh.isEmpty()) return;
        for (String d : fresh) notified.put(d, latest.get(d).substring(0, 15));
        sp.edit().putString("guestNotified", notified.toString()).apply();
        StringBuilder names = new StringBuilder();
        for (String d : fresh) { if (names.length() > 0) names.append(", "); names.append(d.replaceAll("(?i)\\.(mscz|mscx)\\.json$", "").replaceAll("(?i)\\.(mscz|mscx)$", "")); }
        notify(ctx, String.join(", ", who) + " a annoté " + (fresh.size() > 1 ? fresh.size() + " partitions" : "une partition"), names.toString());
    }

    private static void walk(JSONObject f, Pattern p, Map<String, String> out, int depth) throws Exception {
        JSONArray cs = f.optJSONArray("contents");
        if (cs == null) return;
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            if (c.optBoolean("isfolder")) { if (depth < 4) walk(c, p, out, depth + 1); continue; }
            Matcher m = p.matcher(c.optString("name"));
            if (!m.matches()) continue;
            String doc = m.group(2) + ".json", st = m.group(3);
            String cur = out.get(doc);
            if (cur == null || st.compareTo(cur.substring(0, 15)) > 0) out.put(doc, st + "|" + m.group(1));
        }
    }

    private static void walkScores(JSONObject f, List<String[]> out, int depth) throws Exception {
        JSONArray cs = f.optJSONArray("contents");
        if (cs == null) return;
        String fn = f.optString("name", "");
        Matcher fm = Pattern.compile("(?i)^files from (.+?) on .*$").matcher(fn);
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            if (c.optBoolean("isfolder")) { if (depth < 3) walkScores(c, out, depth + 1); continue; }
            if (fm.matches() && c.optString("name").matches("(?i)^.+\\.(mscz|mscx)$"))
                out.add(new String[]{String.valueOf(c.optLong("fileid")), c.optString("name"), fm.group(1)});
        }
    }

    private static String get(String u) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(u).openConnection();
        con.setConnectTimeout(15000); con.setReadTimeout(30000);
        try (InputStream in = con.getInputStream()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[16384]; int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return bo.toString("UTF-8");
        } finally { con.disconnect(); }
    }

    static void notify(Context ctx, String title, String text) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Annotations de ton prof", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(ch);
        }
        Intent i = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        b.setSmallIcon(R.drawable.ic_notif).setContentTitle(title).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(pi).setAutoCancel(true);
        try { nm.notify(7302, b.build()); } catch (SecurityException ignored) { }
    }
}
