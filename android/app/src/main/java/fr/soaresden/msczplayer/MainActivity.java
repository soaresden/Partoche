package fr.soaresden.msczplayer;

import android.app.Activity;
import android.content.Context;
import android.media.AudioManager;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Partoche And Prof : une WebView qui embarque l'appli web (assets/www) + le moteur MuseScore (webmscore).
 * Les fichiers de l'utilisateur sont servis via https://appassets.androidplatform.net/doc/<uri>
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String BASE = "https://" + HOST;
    private static final int REQ_FOLDER = 42;
    private static final int REQ_SAVE = 43;
    private static final int REQ_ROOT = 47;
    private static final int REQ_ROOT_NEW = 48;
    private static final int REQ_EXPORT_LOG = 44;
    private static final int REQ_MIC = 45;
    private android.webkit.PermissionRequest pendingMic;

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MIC && pendingMic != null) {
            if (grantResults.length > 0 && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED)
                pendingMic.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingMic.deny();
            pendingMic = null;
        }
    }

    private WebView web;
    private SharedPreferences prefs;
    private volatile String pendingOpen = null;
    private boolean pageReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);   // boutons volume = son des partitions
        prefs = getSharedPreferences("mcsz", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF16181D);
        // conteneur : la barre d'état / de navigation ne recouvre plus les boutons
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(0xFF16181D);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        applyImmersive();
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebChromeClient(new WebChromeClient() {
            // micro pour l'accordeur
            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsAudio = false;
                    for (String r : request.getResources()) if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
                    if (!wantsAudio) { request.deny(); return; }
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingMic = request;
                        requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return intercept(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "MsczNative");

        logEnvironment();
        handleIntent(getIntent());
        web.loadUrl(BASE + "/assets/www/index.html");
    }

    /** Barre d'état visible (heure, batterie) : on ne masque plus rien */
    private void applyImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.show(WindowInsets.Type.statusBars());
                c.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);   // icônes claires sur fond sombre
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    // ------------------------------------------------------------------ requêtes
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("wasm", "application/wasm");
        MIME.put("data", "application/octet-stream");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("webp", "image/webp");
        MIME.put("woff2", "font/woff2");
    }

    private WebResourceResponse intercept(Uri url) {
        if (!HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null) return null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-cache");
        try {
            if (path.startsWith("/assets/")) {
                String asset = path.substring("/assets/".length());
                String ext = asset.substring(asset.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                InputStream in = getAssets().open(asset);
                return new WebResourceResponse(mime, mime.startsWith("text") ? "utf-8" : null, 200, "OK", headers, in);
            }
            if (path.startsWith("/pc/")) {
                String[] seg = path.substring(4).split("/");
                java.io.File f = pc().downloadCached(new java.io.File(getCacheDir(), "pc"), Long.parseLong(seg[0]), seg.length > 1 ? seg[1] : "0");
                return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, new java.io.FileInputStream(f));
            }
            if (path.startsWith("/doc/")) {
                String enc = url.getEncodedPath().substring("/doc/".length());
                Uri doc = Uri.parse(URLDecoder.decode(enc, "UTF-8"));
                InputStream in = getContentResolver().openInputStream(doc);
                return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, in);
            }
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", headers,
                    new java.io.ByteArrayInputStream(String.valueOf(e.getMessage()).getBytes()));
        }
        return null;
    }

    static String docUrl(Uri u) {
        try { return BASE + "/doc/" + URLEncoder.encode(u.toString(), "UTF-8"); } catch (Exception e) { return ""; }
    }

    // ------------------------------------------------------------------ intents
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri u = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) u = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u == null) return;
        try {
            JSONObject o = new JSONObject();
            String name = "partition.mscz";
            long size = -1;
            try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    if (!c.isNull(0)) name = c.getString(0);
                    if (!c.isNull(1)) size = c.getLong(1);
                }
            } catch (Exception ignored) { }
            o.put("name", name);
            o.put("rel", name);
            o.put("url", docUrl(u));
            if (size >= 0) o.put("size", size);
            String json = o.toString();
            if (pageReady) callJs("window.__native && window.__native.onOpen && window.__native.onOpen(" + JSONObject.quote(json) + ")");
            else pendingOpen = json;
        } catch (Exception ignored) { }
    }

    private void callJs(String js) {
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    // ------------------------------------------------------------------ dossier
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_EXPORT_LOG) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri u = data.getData();
                new Thread(() -> {
                    boolean ok = false;
                    try (java.io.OutputStream o = getContentResolver().openOutputStream(u, "wt")) { o.write(readLog().getBytes("UTF-8")); ok = true; } catch (Exception e) { log("export journal : " + ex(e)); }
                    callJs("window.__native && window.__native.onLogExported && window.__native.onLogExported(" + ok + ")");
                }).start();
            }
            return;
        }
        if (requestCode == REQ_ROOT || requestCode == REQ_ROOT_NEW) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                try { getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
                catch (Exception e) { try { getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { } }
                final boolean fresh = requestCode == REQ_ROOT_NEW;
                new Thread(() -> {
                    String top = DocumentsContract.getTreeDocumentId(tree);
                    if (!fresh) { setupRoot(tree, top, treeLabel(tree)); return; }
                    // nouvelle installation : on crée « Partoche » dans le dossier choisi (sauf s'il s'appelle déjà Partoche And Prof)
                    if ("partoche".equalsIgnoreCase(treeLabel(tree))) { setupRoot(tree, top, treeLabel(tree)); return; }
                    String id = findChild(tree, top, "Partoche");
                    if (id == null) id = mkdir(tree, top, "Partoche");
                    if (id == null) { callJs("window.__native && window.__native.onRootError && window.__native.onRootError('Impossible de créer le dossier Partoche ici')"); return; }
                    setupRoot(tree, id, "Partoche");
                }).start();
            }
            return;
        }
        if (requestCode != REQ_FOLDER && requestCode != REQ_SAVE) return;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri tree = data.getData();
            try {
                getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception e) {
                try { getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
            }
            prefs.edit().putString(requestCode == REQ_FOLDER ? "tree" : "saveTree", tree.toString()).remove("rootTree").remove("storage").apply();
        }
        if (requestCode == REQ_FOLDER) scanAsync();
        callJs("window.__native && window.__native.onInfo && window.__native.onInfo(" + JSONObject.quote(infoJson()) + ")");
        if (requestCode == REQ_SAVE && resultCode == RESULT_OK) {
            log("nouveau dossier de sauvegarde : " + saveTreeUri());
            callJs("window.__native && window.__native.onSaveFolderChanged && window.__native.onSaveFolderChanged()");
        }
    }

    // ---------- dossier « Partoche » : un seul dossier, les sous-dossiers sont trouvés ou créés ----------
    //   Partitions/ (ou MSCZ/)  ·  Eleve/ (ou ApkSettings/)  ·  Prof/
    static final String[] SCORES_NAMES = {"MSCZ", "Partitions"};
    static final String[] SAVE_NAMES = {"Eleve", "Élève", "ApkSettings"};
    private String findAny(Uri tree, String parent, String[] names) {
        java.util.List<Child> ch = children(tree, parent);
        for (String n : names) for (Child c : ch) if (n.equalsIgnoreCase(c.name)) return c.id + "\n" + c.name;
        return null;
    }
    private String mkdir(Uri tree, String parent, String name) {
        try {
            Uri d = DocumentsContract.createDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, parent), DocumentsContract.Document.MIME_TYPE_DIR, name);
            log("dossier « " + name + " » créé");
            return d == null ? null : DocumentsContract.getDocumentId(d);
        } catch (Exception e) { log("✗ création du dossier « " + name + " » : " + ex(e)); return null; }
    }
    /** Ancien dossier unique (Eleve / ApkSettings) -> Settings (fichiers « ! ») et MesNotes (annotations) */
    private void migrateLocal(Uri tree, String oldId, String notesId, String settingsId, String rootId) {
        ContentResolver cr = getContentResolver(); int moved = 0;
        for (Child c : children(tree, oldId)) {
            if (c.dir) continue;
            String to = isSettingsFile(c.name) ? settingsId : notesId;
            Uri src = DocumentsContract.buildDocumentUriUsingTree(tree, c.id);
            boolean ok = false;
            try { ok = DocumentsContract.moveDocument(cr, src, DocumentsContract.buildDocumentUriUsingTree(tree, oldId), DocumentsContract.buildDocumentUriUsingTree(tree, to)) != null; } catch (Exception ignored) { }
            if (!ok) {
                try {
                    Uri dst = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, to), "application/octet-stream", c.name);
                    if (dst != null) {
                        try (InputStream in = cr.openInputStream(src); java.io.OutputStream o = cr.openOutputStream(dst, "wt")) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); }
                        DocumentsContract.deleteDocument(cr, src); ok = true;
                    }
                } catch (Exception e) { log("rangement « " + c.name + " » : " + ex(e)); }
            }
            if (ok) moved++;
        }
        if (children(tree, oldId).isEmpty()) { try { DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, oldId)); } catch (Exception ignored) { } }
        log("ancien dossier élève rangé dans Settings et MesNotes (" + moved + " fichier(s))");
    }
    private void setupRoot(Uri tree, String root, String rootName) {
        String sc = findAny(tree, root, SCORES_NAMES), nt = findAny(tree, root, new String[]{"MesNotes"}), stf = findAny(tree, root, new String[]{"Settings"}), pf = findAny(tree, root, new String[]{"Prof"});
        String oldSv = findAny(tree, root, SAVE_NAMES);
        JSONArray created = new JSONArray();
        String scId, scName;
        if (sc != null) { scId = sc.split("\n")[0]; scName = sc.split("\n")[1]; } else { scId = mkdir(tree, root, "MSCZ"); scName = "MSCZ"; created.put("MSCZ"); }
        String svId = nt != null ? nt.split("\n")[0] : mkdir(tree, root, "MesNotes"); if (nt == null) created.put("MesNotes");
        String stId = stf != null ? stf.split("\n")[0] : mkdir(tree, root, "Settings"); if (stf == null) created.put("Settings");
        String svName = "MesNotes";
        String pfId = pf != null ? pf.split("\n")[0] : mkdir(tree, root, "Prof");
        if (pf == null) created.put("Prof");
        if (scId == null || svId == null) {
            callJs("window.__native && window.__native.onRootError && window.__native.onRootError('Impossible de créer les dossiers (droits d’écriture ?)')");
            return;
        }
        if (oldSv != null && stId != null) migrateLocal(tree, oldSv.split("\n")[0], svId, stId, root);
        prefs.edit().putString("rootTree", tree.toString()).putString("rootId", root).putString("profId", pfId == null ? "" : pfId).putString("rootName", rootName).putString("scoresId", scId).putString("scoresName", scName)
                .putString("saveId", svId).putString("saveName", svName).putString("settingsId", stId == null ? "" : stId).remove("tree").remove("saveTree").remove("storage").apply();
        log("dossier Partoche : " + rootName + " → partitions « " + scName + " », sauvegarde « " + svName + " », créés " + created);
        try {
            int nS = 0; JSONArray tmp = new JSONArray(); scan(getContentResolver(), tree, scId, "", 0, tmp); nS = tmp.length();
            int nE = 0; for (Child c : children(tree, svId)) if (c.name.endsWith(".json")) nE++;
            int nP = 0; if (pfId != null) for (Child c : children(tree, pfId)) if (c.name.endsWith(".json")) nP++;
            JSONObject sum = new JSONObject().put("root", rootName).put("local", true).put("created", created)
                    .put("scores", new JSONObject().put("name", scName).put("count", nS))
                    .put("save", new JSONObject().put("name", svName).put("count", nE))
                    .put("prof", new JSONObject().put("name", "Prof").put("count", nP));
            callJs("window.__native && window.__native.onRootSetup && window.__native.onRootSetup(" + JSONObject.quote(sum.toString()) + ")");
        } catch (Exception ignored) { }
        scanAsync();
        callJs("window.__native && window.__native.onInfo && window.__native.onInfo(" + JSONObject.quote(infoJson()) + ")");
        callJs("window.__native && window.__native.onSaveFolderChanged && window.__native.onSaveFolderChanged()");
    }
    private boolean rootMode() { return !pcMode() && prefs.getString("rootTree", null) != null; }

    // ---------- pCloud direct (compte de l'élève) ----------
    private boolean pcMode() { return "pcloud".equals(prefs.getString("storage", "")) && prefs.getString("pcAuth", null) != null; }
    private PCloud pc() { return new PCloud(prefs.getString("pcApi", PCloud.EU), prefs.getString("pcAuth", ""), "oauth".equals(prefs.getString("pcAuthType", ""))); }

    // ---------- connexion par la page officielle pCloud (OAuth) : Google / Apple / double authentification ----------
    static final String OAUTH_REDIRECT = "https://soaresden.github.io/Partoche/oauth.html";
    private android.app.Dialog oauthDlg;
    private void pcOAuth(String reqId, String clientId) {
        runOnUiThread(() -> {
            WebView w = new WebView(this);
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(true);
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
            final boolean[] done = {false};
            w.setWebViewClient(new WebViewClient() {
                boolean handle(String url) {
                    if (url == null || !url.startsWith(OAUTH_REDIRECT) || done[0]) return false;
                    done[0] = true;
                    Uri u = Uri.parse(url.replace("#", "?"));
                    String res;
                    try {
                        String tok = u.getQueryParameter("access_token"), host = u.getQueryParameter("hostname");
                        if (tok == null) throw new Exception(u.getQueryParameter("error") != null ? u.getQueryParameter("error") : "accès refusé");
                        String api = "https://" + (host != null ? host : ("2".equals(u.getQueryParameter("locationid")) ? "eapi.pcloud.com" : "api.pcloud.com"));
                        prefs.edit().putString("pcApi", api).putString("pcAuth", tok).putString("pcAuthType", "oauth").apply();
                        String email = "";
                        try { email = pc().userInfo().optString("email"); } catch (Exception ignored) { }
                        prefs.edit().putString("pcEmail", email).apply();
                        log("pCloud : connecté via la page pCloud (" + api + ")");
                        res = new JSONObject().put("ok", true).put("email", email).toString();
                    } catch (Exception e) {
                        res = "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
                    }
                    final String out = res;
                    if (oauthDlg != null) oauthDlg.dismiss();
                    callJs("window.__native && window.__native.onPc && window.__native.onPc(" + JSONObject.quote(reqId) + "," + JSONObject.quote(out) + ")");
                    return true;
                }
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return handle(r.getUrl().toString()); }
                @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) { if (handle(url)) v.stopLoading(); }
            });
            oauthDlg = new android.app.Dialog(this, android.R.style.Theme_DeviceDefault_NoActionBar);
            oauthDlg.setContentView(w);
            oauthDlg.setOnCancelListener(d -> {
                if (!done[0]) callJs("window.__native && window.__native.onPc && window.__native.onPc(" + JSONObject.quote(reqId) + "," + JSONObject.quote("{\"error\":\"annulé\"}") + ")");
            });
            oauthDlg.show();
            w.loadUrl("https://my.pcloud.com/oauth2/authorize?client_id=" + Uri.encode(clientId) + "&response_type=token&permissions=manageshares&redirect_uri=" + Uri.encode(OAUTH_REDIRECT));
        });
    }
    // ---------- connexion par le site pCloud dans l'appli : on récupère la session une fois connecté ----------
    // (marche avec la double authentification ; Google / Apple selon ce que Google accepte dans une vue intégrée)
    private android.app.Dialog webDlg;
    private void pcWebLogin(String reqId) {
        runOnUiThread(() -> {
            android.widget.LinearLayout box = new android.widget.LinearLayout(this);
            box.setOrientation(android.widget.LinearLayout.VERTICAL);
            box.setBackgroundColor(0xff1a1d24);
            android.widget.LinearLayout top = new android.widget.LinearLayout(this);
            top.setPadding(24, 18, 24, 18); top.setGravity(android.view.Gravity.CENTER_VERTICAL);
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText("Connecte-toi à pCloud : Partoche And Prof récupère la connexion tout seul.");
            tv.setTextColor(0xffe8ebf0); tv.setTextSize(15);
            top.addView(tv, new android.widget.LinearLayout.LayoutParams(0, -2, 1));
            android.widget.Button close = new android.widget.Button(this); close.setText("Fermer");
            top.addView(close);
            box.addView(top);
            WebView w = new WebView(this);
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(true);
            // vue intégrée vue comme un vrai Chrome (sinon Google refuse la connexion)
            String ua = w.getSettings().getUserAgentString().replace("; wv", "").replaceAll("Version/[\\d.]+ ", "");
            w.getSettings().setUserAgentString(ua);
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.setAcceptCookie(true); cm.setAcceptThirdPartyCookies(w, true);
            w.setWebViewClient(new WebViewClient());
            w.setWebChromeClient(new android.webkit.WebChromeClient());
            box.addView(w, new android.widget.LinearLayout.LayoutParams(-1, 0, 1));
            final boolean[] done = {false};
            final android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
            final java.util.Set<String> tried = new java.util.HashSet<>();
            final Runnable[] poll = new Runnable[1];
            poll[0] = () -> {
                if (done[0]) return;
                java.util.List<String> cand = new java.util.ArrayList<>();
                for (String u : new String[]{"https://my.pcloud.com", "https://e.pcloud.com", "https://u.pcloud.com", "https://www.pcloud.com", "https://pcloud.com"}) {
                    String c = cm.getCookie(u); if (c == null) continue;
                    for (String part : c.split(";")) {
                        String[] kv = part.trim().split("=", 2);
                        if (kv.length == 2 && kv[0].toLowerCase(Locale.ROOT).contains("auth") && kv[1].length() >= 20 && kv[1].length() <= 200 && tried.add(kv[1])) cand.add(kv[1]);
                    }
                }
                // la page peut aussi garder la session dans son stockage local
                w.evaluateJavascript("(function(){try{var o=[];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i),v=localStorage.getItem(k);if(/auth/i.test(k)&&v&&v.length<300)o.push(v.replace(/\"/g,''));}return o.join('|')}catch(e){return ''}})()", v -> {
                    java.util.List<String> all = new java.util.ArrayList<>(cand);
                    if (v != null) for (String x : v.replace("\"", "").split("\\|")) if (x.length() >= 20 && x.length() <= 200 && tried.add(x)) all.add(x);
                    if (!all.isEmpty()) new Thread(() -> {
                        for (String tok : all) for (String api : new String[]{PCloud.EU, PCloud.US}) {
                            if (done[0]) return;
                            try {
                                JSONObject info = new PCloud(api, tok).userInfo();
                                done[0] = true;
                                String email = info.optString("email", "");
                                prefs.edit().putString("pcApi", api).putString("pcAuth", tok).putString("pcEmail", email).remove("pcAuthType").apply();
                                log("pCloud : connecté par le site pCloud (" + api + ")");
                                String out = new JSONObject().put("ok", true).put("email", email).toString();
                                runOnUiThread(() -> { if (webDlg != null) webDlg.dismiss(); });
                                callJs("window.__native && window.__native.onPc && window.__native.onPc(" + JSONObject.quote(reqId) + "," + JSONObject.quote(out) + ")");
                                return;
                            } catch (Exception ignored) { }
                        }
                    }).start();
                });
                h.postDelayed(poll[0], 1200);
            };
            webDlg = new android.app.Dialog(this, android.R.style.Theme_DeviceDefault_NoActionBar);
            webDlg.setContentView(box);
            Runnable cancel = () -> { if (!done[0]) { done[0] = true; callJs("window.__native && window.__native.onPc && window.__native.onPc(" + JSONObject.quote(reqId) + "," + JSONObject.quote("{\"error\":\"annulé\"}") + ")"); } };
            webDlg.setOnCancelListener(d -> cancel.run());
            close.setOnClickListener(v -> { cancel.run(); webDlg.dismiss(); });
            webDlg.show();
            w.loadUrl("https://my.pcloud.com/");
            h.postDelayed(poll[0], 1500);
        });
    }
    private long pcId(String k) { return prefs.getLong(k, -1); }
    static final String[] PC_SCORES = {"MSCZ", "Partitions"}, PC_SAVE = {"Eleve", "Élève", "ApkSettings"}, PC_PROF = {"Prof"};

    /** Fichiers d'un dossier pCloud (non récursif) : nom -> métadonnées */
    private java.util.Map<String, JSONObject> pcFiles(long folderId) throws Exception {
        java.util.Map<String, JSONObject> m = new java.util.LinkedHashMap<>();
        JSONArray cs = pc().listFolder(folderId, false, false).optJSONArray("contents");
        if (cs != null) for (int i = 0; i < cs.length(); i++) { JSONObject c = cs.getJSONObject(i); if (!c.optBoolean("isfolder")) m.put(c.getString("name"), c); }
        return m;
    }
    private static JSONObject findFolder(JSONArray cs, String[] names) throws Exception {
        if (cs == null) return null;
        for (String n : names) for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            if (c.optBoolean("isfolder") && n.equalsIgnoreCase(c.getString("name"))) return c;
        }
        return null;
    }
    private static int countFiles(JSONObject folder, String ext) throws Exception {
        int n = 0; JSONArray cs = folder.optJSONArray("contents");
        if (cs != null) for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            if (c.optBoolean("isfolder")) n += countFiles(c, ext);
            else if (ext == null || c.getString("name").toLowerCase(Locale.ROOT).endsWith(ext)) n++;
        }
        return n;
    }
    /** Dossier Partoche choisi : on trouve (ou crée) MSCZ, Eleve et Prof. */
    private JSONObject pcUseRoot(long rootId) throws Exception {
        PCloud p = pc();
        JSONObject root = p.listFolder(rootId, true, false);
        JSONArray cs = root.optJSONArray("contents");
        JSONArray created = new JSONArray();
        JSONObject sc = findFolder(cs, PC_SCORES), nt = findFolder(cs, new String[]{"MesNotes"}), stf = findFolder(cs, new String[]{"Settings"}), pf = findFolder(cs, PC_PROF);
        JSONObject old = findFolder(cs, PC_SAVE);   // ancien dossier unique (Eleve / ApkSettings)
        long scId = sc != null ? sc.getLong("folderid") : p.createFolder(rootId, "MSCZ");
        long ntId = nt != null ? nt.getLong("folderid") : p.createFolder(rootId, "MesNotes");
        long stId = stf != null ? stf.getLong("folderid") : p.createFolder(rootId, "Settings");
        long pfId = pf != null ? pf.getLong("folderid") : p.createFolder(rootId, "Prof");
        if (sc == null) created.put("MSCZ"); if (nt == null) created.put("MesNotes"); if (stf == null) created.put("Settings"); if (pf == null) created.put("Prof");
        // rangement : « ! » -> Settings, annotations -> MesNotes, puis on supprime l'ancien dossier s'il est vide
        int moved = 0;
        if (old != null) {
            JSONArray oc = old.optJSONArray("contents"); int left = 0;
            if (oc != null) for (int i = 0; i < oc.length(); i++) {
                JSONObject f = oc.getJSONObject(i);
                if (f.optBoolean("isfolder")) { left++; continue; }
                String fn = f.getString("name");
                try { p.call("renamefile", PCloud.p("fileid", String.valueOf(f.getLong("fileid")), "tofolderid", String.valueOf(isSettingsFile(fn) ? stId : ntId))); moved++; }
                catch (Exception e) { log("rangement « " + fn + " » : " + ex(e)); left++; }
            }
            if (left == 0) { try { p.call("deletefolder", PCloud.p("folderid", String.valueOf(old.getLong("folderid")))); } catch (Exception ignored) { } }
            log("pCloud : ancien dossier « " + old.optString("name") + " » rangé dans Settings et MesNotes (" + moved + " fichier(s))");
        }
        prefs.edit().putString("storage", "pcloud").putLong("pcRoot", rootId).putString("pcRootName", root.optString("name", "Partoche"))
                .putLong("pcScores", scId).putString("pcScoresName", sc != null ? sc.getString("name") : "MSCZ")
                .putLong("pcSave", ntId).putString("pcSaveName", "MesNotes")
                .putLong("pcSettings", stId)
                .putLong("pcProf", pfId).putString("pcProfName", pf != null ? pf.getString("name") : "Prof").apply();
        log("pCloud : dossier « " + root.optString("name") + " » → MSCZ, MesNotes, Settings, Prof ; créés " + created);
        int nNotes = (nt == null ? 0 : countFiles(nt, ".json")) + (old == null ? 0 : countFiles(old, ".json"));
        return new JSONObject().put("root", root.optString("name"))
                .put("scores", new JSONObject().put("name", prefs.getString("pcScoresName", "")).put("count", sc == null ? 0 : countFiles(sc, ".mscz") + countFiles(sc, ".mscx")))
                .put("save", new JSONObject().put("name", "MesNotes + Settings").put("count", nNotes))
                .put("prof", new JSONObject().put("name", prefs.getString("pcProfName", "")).put("count", pf == null ? 0 : countFiles(pf, ".json")))
                .put("created", created);
    }
    private void pcScan(JSONObject folder, String prefix, JSONArray out, int depth) throws Exception {
        JSONArray cs = folder.optJSONArray("contents");
        if (cs == null) return;
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.getJSONObject(i);
            String name = c.getString("name");
            if (c.optBoolean("isfolder")) { if (depth < 5 && !name.startsWith(".")) pcScan(c, prefix + name + "/", out, depth + 1); continue; }
            String low = name.toLowerCase(Locale.ROOT);
            if (!low.endsWith(".mscz") && !low.endsWith(".mscx")) continue;
            JSONObject o = new JSONObject();
            o.put("name", name); o.put("rel", prefix + name);
            o.put("url", BASE + "/pc/" + c.getLong("fileid") + "/" + c.optString("hash", "0"));
            o.put("size", c.optLong("size")); o.put("mtime", PCloud.parseDate(c.optString("modified")));
            out.put(o);
        }
    }
    private String pcReqResult(String action, JSONObject a) throws Exception {
        switch (action) {
            case "login": {
                JSONObject r = PCloud.login(a.getString("email"), a.getString("password"));
                if (r.optBoolean("needTfa")) { prefs.edit().putString("pcTfaToken", r.getString("token")).putString("pcTfaApi", r.getString("api")).apply(); return r.toString(); }
                prefs.edit().putString("pcApi", r.getString("api")).putString("pcAuth", r.getString("auth")).putString("pcEmail", r.optString("email")).remove("pcAuthType").apply();
                log("pCloud : connecté (" + r.optString("email") + ", " + r.getString("api") + ")");
                return new JSONObject().put("ok", true).put("email", r.optString("email")).toString();
            }
            case "tfa": {
                JSONObject r = PCloud.tfaLogin(prefs.getString("pcTfaApi", PCloud.EU), prefs.getString("pcTfaToken", ""), a.getString("code"));
                prefs.edit().putString("pcApi", r.getString("api")).putString("pcAuth", r.getString("auth")).putString("pcEmail", r.optString("email")).remove("pcAuthType").apply();
                return new JSONObject().put("ok", true).put("email", r.optString("email")).toString();
            }
            case "logout": {
                prefs.edit().remove("pcAuth").remove("pcApi").remove("pcEmail").remove("pcAuthType").remove("storage").remove("pcRoot").remove("pcScores").remove("pcSave").remove("pcProf").apply();
                return "{\"ok\":true}";
            }
            case "folders": {
                JSONObject md = pc().listFolder(a.optLong("folderid", 0), false, true);
                JSONArray out = new JSONArray(), cs = md.optJSONArray("contents");
                if (cs != null) for (int i = 0; i < cs.length(); i++) { JSONObject c = cs.getJSONObject(i); if (c.optBoolean("isfolder")) out.put(new JSONObject().put("id", c.getLong("folderid")).put("name", c.getString("name"))); }
                return new JSONObject().put("id", md.optLong("folderid")).put("name", md.optString("name", "/")).put("parent", md.optLong("parentfolderid", -1)).put("folders", out).toString();
            }
            case "mkdir": return new JSONObject().put("id", pc().createFolder(a.getLong("parent"), a.getString("name"))).toString();
            case "useRoot": {
                JSONObject r = pcUseRoot(a.getLong("folderid"));
                scanAsync();
                callJs("window.__native && window.__native.onInfo && window.__native.onInfo(" + JSONObject.quote(infoJson()) + ")");
                return r.toString();
            }
            case "share": {
                PCloud p = pc();
                JSONObject pub = p.folderPublink(pcId("pcRoot"), a.optString("password"));
                JSONObject up = p.uploadLink(pcId("pcProf"), "Annotations du prof (Partoche)");
                return new JSONObject().put("link", pub.optString("link")).put("upload", up.optString("link")).toString();
            }
            case "links": {   // liens déjà existants sur le dossier Partoche / Prof
                PCloud p = pc(); JSONObject out = new JSONObject();
                try { JSONArray l = p.call("listpublinks", PCloud.p()).optJSONArray("publinks");
                    if (l != null) for (int i = 0; i < l.length(); i++) { JSONObject x = l.getJSONObject(i); JSONObject md = x.optJSONObject("metadata");
                        if (md != null && md.optLong("folderid", -1) == pcId("pcRoot")) { out.put("link", x.optString("link")); out.put("haspassword", x.optBoolean("haspassword")); } } } catch (Exception ignored) { }
                try { JSONArray l = p.call("listuploadlinks", PCloud.p()).optJSONArray("uploadlinks");
                    if (l != null) for (int i = 0; i < l.length(); i++) { JSONObject x = l.getJSONObject(i); JSONObject md = x.optJSONObject("metadata");
                        if (md != null && md.optLong("folderid", -1) == pcId("pcProf")) out.put("upload", x.optString("link")); } } catch (Exception ignored) { }
                return out.toString();
            }
            case "account": {
                JSONObject u = pc().userInfo();
                return new JSONObject().put("email", u.optString("email")).put("premium", u.optBoolean("premium")).toString();
            }
        }
        throw new Exception("action inconnue " + action);
    }
    private String scoresRootId(Uri tree) { return rootMode() ? prefs.getString("scoresId", null) : DocumentsContract.getTreeDocumentId(tree); }

    private static String treeLabel(Uri tree) {
        String label = DocumentsContract.getTreeDocumentId(tree);
        int k = Math.max(label.lastIndexOf('/'), label.lastIndexOf(':'));
        if (k >= 0 && k < label.length() - 1) label = label.substring(k + 1);
        return label;
    }

    private String infoJson() {
        JSONObject o = new JSONObject();
        try {
            Uri t = treeUri(), st = saveTreeUri();
            o.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
            if (pcMode()) {
                o.put("storage", "pcloud"); o.put("pcEmail", prefs.getString("pcEmail", ""));
                boolean has = pcId("pcRoot") >= 0;
                o.put("rootFolder", has ? "pCloud · " + prefs.getString("pcRootName", "") : "");
                o.put("scoresFolder", has ? "pCloud · " + prefs.getString("pcRootName", "") + " / " + prefs.getString("pcScoresName", "") : "");
                o.put("saveFolder", has ? "pCloud · " + prefs.getString("pcRootName", "") + " / " + prefs.getString("pcSaveName", "") : "");
                o.put("profFolder", has ? prefs.getString("pcProfName", "") : "");
                o.put("saveWritable", true); o.put("saveCustom", false); o.put("saveProvider", ""); o.put("saveLocal", true);
                return o.toString();
            }
            o.put("pcEmail", prefs.getString("pcAuth", null) != null ? prefs.getString("pcEmail", "") : "");
            o.put("rootFolder", rootMode() ? prefs.getString("rootName", treeLabel(t)) : "");
            if (rootMode()) {
                o.put("scoresFolder", prefs.getString("rootName", treeLabel(t)) + " / " + prefs.getString("scoresName", ""));
                o.put("saveFolder", prefs.getString("rootName", treeLabel(t)) + " / " + prefs.getString("saveName", ""));
                o.put("saveCustom", false);
                o.put("saveWritable", canWrite(t));
                o.put("saveProvider", t.getAuthority());
                o.put("saveLocal", "com.android.externalstorage.documents".equals(t.getAuthority()));
                o.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
                return o.toString();
            }
            o.put("scoresFolder", t == null ? "" : treeLabel(t));
            o.put("scoresWritable", t != null && canWrite(t));
            o.put("saveFolder", st == null ? (t == null ? "" : treeLabel(t) + " / " + DATA_DIR) : treeLabel(st));
            o.put("saveCustom", st != null);
            o.put("saveWritable", st != null ? canWrite(st) : (t != null && canWrite(t)));
            Uri eff = st != null ? st : t;
            String auth = eff == null ? "" : eff.getAuthority();
            o.put("saveProvider", auth);
            o.put("saveLocal", "com.android.externalstorage.documents".equals(auth));
            o.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
        } catch (Exception ignored) { }
        return o.toString();
    }

    // ---------- rangement des envois du prof ----------
    // Un lien « Demander des fichiers » range chaque envoi dans un dossier « Files from <Prof> on <date> ».
    // On remet ces fichiers dans Prof/, on ne garde que le plus récent par partition et par prof, et on supprime les dossiers vides.
    static final java.util.regex.Pattern DROP = java.util.regex.Pattern.compile("^(.+?) - (.+\\.(?:mscz|mscx)|!Agenda|!Avis) - (\\d{8}-\\d{6})(?: ?\\(\\d+\\))?\\.json$", java.util.regex.Pattern.CASE_INSENSITIVE);
    static final java.util.regex.Pattern SCORE = java.util.regex.Pattern.compile("(?i)^.+\\.(mscz|mscx)$");
    /** « Files from Marie on 2026-10-02 … » -> « Marie » */
    static String dropAuthor(String folder) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)^files from (.+?) on .*$").matcher(folder == null ? "" : folder);
        return m.matches() ? m.group(1).trim() : "Prof";
    }
    private String nameOf(Uri tree, String docId) {
        try (android.database.Cursor c = getContentResolver().query(DocumentsContract.buildDocumentUriUsingTree(tree, docId), new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return "";
    }
    /** partitions reçues de la prof : signalées à la page au prochain scan */
    private synchronized void noteNewScore(String who, String name) {
        try {
            JSONArray a = new JSONArray(prefs.getString("newScores", "[]"));
            a.put(new JSONObject().put("who", who).put("name", name));
            prefs.edit().putString("newScores", a.toString()).apply();
        } catch (Exception ignored) { }
        log("partition reçue de " + who + " : " + name + " → dossier des partitions");
    }
    private synchronized JSONArray takeNewScores() {
        try { JSONArray a = new JSONArray(prefs.getString("newScores", "[]")); prefs.edit().remove("newScores").apply(); return a; } catch (Exception e) { return new JSONArray(); }
    }
    private static boolean isDropFolder(String n) { return n != null && n.toLowerCase(Locale.ROOT).startsWith("files from "); }
    private final Object tidyLock = new Object();
    private volatile int tidyChanges = 0;
    private void tidyDrops() {
        synchronized (tidyLock) {
            try { if (pcMode()) tidyPc(); else if (rootMode()) tidyLocal(); } catch (Exception e) { log("rangement des envois du prof : " + ex(e)); }
        }
    }
    private void tidyLocal() throws Exception {
        Uri tree = treeUri(); if (tree == null) return;
        String root = prefs.getString("rootId", DocumentsContract.getTreeDocumentId(tree));
        String prof = prefs.getString("profId", "");
        if (prof.isEmpty()) { prof = findChild(tree, root, "Prof"); if (prof == null) prof = mkdir(tree, root, "Prof"); if (prof == null) return; prefs.edit().putString("profId", prof).apply(); }
        ContentResolver cr = getContentResolver();
        java.util.List<String[]> dirs = new java.util.ArrayList<>();   // {id, parentId}
        for (Child c : children(tree, root)) if (isDropFolder(c.name)) dirs.add(new String[]{c.id, root});
        for (Child c : children(tree, prof)) if (isDropFolder(c.name)) dirs.add(new String[]{c.id, prof});
        int moved = 0;
        String scores = prefs.getString("scoresId", "");
        for (String[] d : dirs) {
            for (Child f : children(tree, d[0])) {
                if (SCORE.matcher(f.name).matches() && !scores.isEmpty()) {   // partition envoyée par la prof -> MSCZ
                    try {
                        if (DocumentsContract.moveDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, f.id), DocumentsContract.buildDocumentUriUsingTree(tree, d[0]), DocumentsContract.buildDocumentUriUsingTree(tree, scores)) != null)
                            noteNewScore(dropAuthor(nameOf(tree, d[0])), f.name);
                    } catch (Exception e) { log("partition du prof non déplacée : " + f.name + " — " + ex(e)); }
                    continue;
                }
                if (f.dir) continue;
                // envoi du prof (annotations, agenda…) ou autre fichier déposé : tout va dans Prof, le dossier « Files from » disparaît
                Uri src = DocumentsContract.buildDocumentUriUsingTree(tree, f.id);
                boolean ok = false;
                try { ok = DocumentsContract.moveDocument(cr, src, DocumentsContract.buildDocumentUriUsingTree(tree, d[0]), DocumentsContract.buildDocumentUriUsingTree(tree, prof)) != null; } catch (Exception ignored) { }
                if (!ok) {   // fournisseur sans « déplacer » : copie puis suppression
                    String txt = readDoc(tree, f.id);
                    if (txt == null) continue;
                    Uri dst = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, prof), "application/json", f.name);
                    if (dst == null) continue;
                    try (java.io.OutputStream o = cr.openOutputStream(dst, "wt")) { o.write(txt.getBytes("UTF-8")); }
                    DocumentsContract.deleteDocument(cr, src); ok = true;
                }
                if (ok) moved++;
            }
            if (children(tree, d[0]).isEmpty()) { try { DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, d[0])); } catch (Exception ignored) { } }
        }
        // un seul fichier par partition et par prof : le plus récent
        java.util.Map<String, Child> keep = new HashMap<>(); java.util.Map<String, String> keepSt = new HashMap<>();
        java.util.List<Child> old = new java.util.ArrayList<>();
        for (Child f : children(tree, prof)) {
            java.util.regex.Matcher m = DROP.matcher(f.name); if (!m.matches()) continue;
            String k = m.group(1).toLowerCase(Locale.ROOT) + "|" + m.group(2), st = m.group(3);
            if (!keep.containsKey(k)) { keep.put(k, f); keepSt.put(k, st); }
            else if (st.compareTo(keepSt.get(k)) > 0) { old.add(keep.get(k)); keep.put(k, f); keepSt.put(k, st); }
            else old.add(f);
        }
        for (Child f : old) { try { DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, f.id)); } catch (Exception ignored) { } }
        String stId = prefs.getString("settingsId", "");
        if (!stId.isEmpty()) for (Child c : children(tree, root)) {
            if (!c.dir) continue;
            boolean legacy = false; for (String n : SAVE_NAMES) if (n.equalsIgnoreCase(c.name)) legacy = true;
            if (!legacy) continue;
            if (children(tree, c.id).isEmpty()) { try { DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, c.id)); moved++; } catch (Exception ignored) { } }
            else migrateLocal(tree, c.id, prefs.getString("saveId", ""), stId, root);
        }
        tidyChanges += moved + old.size();
        if (moved > 0 || !old.isEmpty()) log("rangement Prof : " + moved + " envoi(s) remis dans Prof, " + old.size() + " ancienne(s) version(s) supprimée(s)");
    }
    private void tidyPc() throws Exception {
        long root = pcId("pcRoot"), prof = pcId("pcProf"); if (root < 0 || prof < 0) return;
        PCloud p = pc();
        JSONObject tree = p.listFolder(root, true, false);
        int moved = 0;
        java.util.List<JSONObject> dirs = new java.util.ArrayList<>();
        JSONArray top = tree.optJSONArray("contents");
        if (top != null) for (int i = 0; i < top.length(); i++) {
            JSONObject c = top.getJSONObject(i);
            if (c.optBoolean("isfolder") && isDropFolder(c.getString("name"))) dirs.add(c);
            if (c.optBoolean("isfolder") && c.optLong("folderid") == prof) { JSONArray pc2 = c.optJSONArray("contents"); if (pc2 != null) for (int j = 0; j < pc2.length(); j++) { JSONObject x = pc2.getJSONObject(j); if (x.optBoolean("isfolder") && isDropFolder(x.getString("name"))) dirs.add(x); } }
        }
        for (JSONObject d : dirs) {
            JSONArray cs = d.optJSONArray("contents"); int left = 0;
            if (cs != null) for (int i = 0; i < cs.length(); i++) {
                JSONObject f = cs.getJSONObject(i);
                String fn = f.optString("name");
                if (!f.optBoolean("isfolder") && SCORE.matcher(fn).matches() && pcId("pcScores") >= 0) {   // partition envoyée par la prof -> MSCZ
                    String fid = String.valueOf(f.getLong("fileid")), to = String.valueOf(pcId("pcScores"));
                    try { p.call("renamefile", PCloud.p("fileid", fid, "tofolderid", to)); }
                    catch (Exception e) {   // même nom déjà présent : on suffixe
                        String alt = fn.replaceAll("(?i)\\.(mscz|mscx)$", "") + " (" + dropAuthor(d.optString("name")) + " " + new java.text.SimpleDateFormat("yyyy-MM-dd HHmm", Locale.ROOT).format(new java.util.Date()) + ")" + fn.substring(fn.lastIndexOf('.'));
                        try { p.call("renamefile", PCloud.p("fileid", fid, "tofolderid", to, "toname", alt)); fn = alt; } catch (Exception e2) { log("partition du prof non déplacée : " + fn + " — " + ex(e2)); left++; continue; }
                    }
                    noteNewScore(dropAuthor(d.optString("name")), fn);
                } else if (!f.optBoolean("isfolder")) {
                    // envoi du prof (annotations, agenda…) ou autre fichier : tout va dans Prof
                    String fid = String.valueOf(f.getLong("fileid"));
                    try { p.call("renamefile", PCloud.p("fileid", fid, "tofolderid", String.valueOf(prof))); moved++; }
                    catch (Exception e) {
                        // même nom déjà dans Prof (envoi en double) : on garde celui de Prof
                        if (DROP.matcher(fn).matches()) { try { p.delete(f.getLong("fileid")); moved++; } catch (Exception e2) { left++; } }
                        else { try { p.call("renamefile", PCloud.p("fileid", fid, "tofolderid", String.valueOf(prof), "toname", System.currentTimeMillis() + " " + fn)); moved++; } catch (Exception e2) { left++; } }
                    }
                } else left++;
            }
            if (left == 0) { try { p.call("deletefolder", PCloud.p("folderid", String.valueOf(d.getLong("folderid")))); } catch (Exception ignored) { } }
        }
        java.util.Map<String, JSONObject> keep = new HashMap<>(); java.util.List<JSONObject> old = new java.util.ArrayList<>();
        JSONArray pcs = p.listFolder(prof, false, false).optJSONArray("contents");
        if (pcs != null) for (int i = 0; i < pcs.length(); i++) {
            JSONObject f = pcs.getJSONObject(i); if (f.optBoolean("isfolder")) continue;
            java.util.regex.Matcher m = DROP.matcher(f.getString("name")); if (!m.matches()) continue;
            String k = m.group(1).toLowerCase(Locale.ROOT) + "|" + m.group(2);
            JSONObject cur = keep.get(k);
            if (cur == null) keep.put(k, f);
            else { java.util.regex.Matcher mc = DROP.matcher(cur.getString("name")); mc.matches();
                if (m.group(3).compareTo(mc.group(3)) > 0) { old.add(cur); keep.put(k, f); } else old.add(f); }
        }
        for (JSONObject f : old) { try { p.delete(f.getLong("fileid")); } catch (Exception ignored) { } }
        // ancien dossier élève (Eleve / ApkSettings) revenu vide : on le supprime
        if (pcId("pcSettings") >= 0 && top != null) for (int i = 0; i < top.length(); i++) {
            JSONObject c = top.getJSONObject(i);
            if (!c.optBoolean("isfolder")) continue;
            boolean legacy = false; for (String n : PC_SAVE) if (n.equalsIgnoreCase(c.optString("name"))) legacy = true;
            if (!legacy) continue;
            JSONArray lc = c.optJSONArray("contents");
            if (lc == null || lc.length() == 0) { try { p.call("deletefolder", PCloud.p("folderid", String.valueOf(c.getLong("folderid")))); moved++; log("dossier vide « " + c.optString("name") + " » supprimé"); } catch (Exception ignored) { } }
            else { try { pcUseRoot(root); } catch (Exception ignored) { } }   // il contient des fichiers : on les range
        }
        tidyChanges += moved + old.size();
        if (moved > 0 || !old.isEmpty()) log("rangement Prof (pCloud) : " + moved + " envoi(s) remis dans Prof, " + old.size() + " ancienne(s) version(s) supprimée(s)");
    }

    /** Installations d'avant la 4.7 : un seul dossier élève -> Settings + MesNotes (une fois) */
    private void migrateIfNeeded() {
        try {
            if (pcMode() && pcId("pcSettings") < 0 && pcId("pcRoot") >= 0) { pcUseRoot(pcId("pcRoot")); return; }
            if (rootMode() && prefs.getString("settingsId", "").isEmpty()) {
                Uri tree = treeUri(); if (tree == null) return;
                String root = prefs.getString("rootId", DocumentsContract.getTreeDocumentId(tree));
                String nt = findAny(tree, root, new String[]{"MesNotes"}), stf = findAny(tree, root, new String[]{"Settings"}), old = findAny(tree, root, SAVE_NAMES);
                String ntId = nt != null ? nt.split("\n")[0] : mkdir(tree, root, "MesNotes"), stId = stf != null ? stf.split("\n")[0] : mkdir(tree, root, "Settings");
                if (ntId == null || stId == null) return;
                if (old != null) migrateLocal(tree, old.split("\n")[0], ntId, stId, root);
                prefs.edit().putString("saveId", ntId).putString("saveName", "MesNotes").putString("settingsId", stId).apply();
            }
        } catch (Exception e) { log("rangement Settings / MesNotes : " + ex(e)); }
    }

    private void scanAsync() {
        new Thread(() -> {
            migrateIfNeeded();
            tidyDrops();
            JSONObject res = new JSONObject();
            JSONArray arr = new JSONArray();
            if (pcMode()) {
                try {
                    pcScan(pc().listFolder(pcId("pcScores"), true, false), "", arr, 0);
                    res.put("folder", prefs.getString("pcRootName", "") + " / " + prefs.getString("pcScoresName", ""));
                    res.put("writable", true);
                    res.put("files", arr);
                    res.put("data", new JSONArray(listDataImpl()));
                    res.put("fromProf", takeNewScores());
                } catch (Exception e) {
                    log("✗ pCloud, lecture des partitions : " + ex(e));
                    try { res.put("files", arr); res.put("error", "pCloud : " + e.getMessage()); } catch (Exception ignored) { }
                }
                callJs("window.__native && window.__native.onFiles && window.__native.onFiles(" + JSONObject.quote(res.toString()) + ")");
                return;
            }
            try {
                Uri treeU = treeUri();
                if (treeU != null) {
                    Uri tree = treeU;
                    String rootId = scoresRootId(tree);
                    String label = rootMode() ? prefs.getString("scoresName", "Partitions") : rootId;
                    int k = Math.max(label.lastIndexOf('/'), label.lastIndexOf(':'));
                    if (k >= 0 && k < label.length() - 1) label = label.substring(k + 1);
                    res.put("folder", label);
                    res.put("writable", canWrite(tree));
                    scan(getContentResolver(), tree, rootId, "", 0, arr);
                }
                res.put("files", arr);
                res.put("data", new JSONArray(listDataImpl()));
                res.put("fromProf", takeNewScores());
            } catch (Exception e) {
                try { res.put("files", arr); res.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            }
            callJs("window.__native && window.__native.onFiles && window.__native.onFiles(" + JSONObject.quote(res.toString()) + ")");
        }).start();
    }

    private void scan(ContentResolver cr, Uri tree, String docId, String prefix, int depth, JSONArray out) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        try (Cursor c = queryFresh(children, cols)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                if (name == null) continue;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (depth < 4 && !name.startsWith(".") && !name.equals(DATA_DIR) && !name.equals(OLD_DIR)) scan(cr, tree, id, prefix + name + "/", depth + 1, out);
                } else {
                    String low = name.toLowerCase(Locale.ROOT);
                    if (low.endsWith(".mscz") || low.endsWith(".mscx")) {
                        JSONObject o = new JSONObject();
                        o.put("name", name);
                        o.put("rel", prefix + name);
                        o.put("url", docUrl(DocumentsContract.buildDocumentUriUsingTree(tree, id)));
                        o.put("size", c.isNull(3) ? 0 : c.getLong(3));
                        o.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                        out.put(o);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ données de l'appli
    // <dossier de sauvegarde>/            (par défaut <partitions>/_MSCZ Player, ou celui choisi dans Options)
    //     !Settings.json                  préférences + historique
    //     <partition>.mscz.json           un fichier par partition (état actuel)
    // Écriture : file d'attente unique, un fichier à la fois, écart mini entre 2 écritures du même
    // fichier, vérification par relecture, nouvel essai jusqu'à réussite. Jamais de création si le
    // fichier existe déjà (on l'ouvre et on remplace son contenu) -> pas de « conflicted ».
    static final String DATA_DIR = "_MSCZ Player";
    static final String OLD_DIR = "MSCZ Player - annotations";

    private boolean canWrite(Uri tree) {
        for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isWritePermission()) return true;
        }
        return false;
    }

    private Uri treeUri() {
        String t = prefs.getString("rootTree", null);
        if (t == null) t = prefs.getString("tree", null);
        return t == null ? null : Uri.parse(t);
    }

    private Uri saveTreeUri() {
        String t = prefs.getString("saveTree", null);
        return t == null ? null : Uri.parse(t);
    }

    static class Child { String id, name; long mtime, size; boolean dir; }

    /**
     * Requête « fraîche » : un fournisseur cloud (pCloud) renvoie d'abord sa liste en cache avec
     * EXTRA_LOADING=true puis se met à jour en arrière-plan. On attend la fin du chargement (max ~8 s).
     */
    private Cursor queryFresh(Uri u, String[] cols) {
        Cursor c = null;
        long t0 = System.currentTimeMillis();
        for (int k = 0; k < 20; k++) {
            try { c = getContentResolver().query(u, cols, null, null, null); } catch (Exception e) { c = null; }
            if (c == null) return null;
            android.os.Bundle ex = c.getExtras();
            boolean loading = ex != null && ex.getBoolean(DocumentsContract.EXTRA_LOADING, false);
            if (!loading) {
                if (k > 0) log("  liste à jour après " + (System.currentTimeMillis() - t0) + " ms de chargement pCloud");
                return c;
            }
            c.close(); c = null;
            sleep(400);
        }
        log("  ⚠ liste toujours en chargement après 8 s — on utilise la version en cache");
        try { return getContentResolver().query(u, cols, null, null, null); } catch (Exception e) { return null; }
    }

    private java.util.List<Child> children(Uri tree, String parentId) {
        java.util.List<Child> out = new java.util.ArrayList<>();
        Uri u = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor c = queryFresh(u, new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_MIME_TYPE})) {
            if (c != null) while (c.moveToNext()) {
                Child ch = new Child();
                ch.id = c.getString(0); ch.name = c.getString(1);
                ch.mtime = c.isNull(2) ? 0 : c.getLong(2); ch.size = c.isNull(3) ? 0 : c.getLong(3);
                ch.dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(4));
                out.add(ch);
            }
        } catch (Exception ignored) { }
        return out;
    }

    private String findChild(Uri tree, String parentId, String name) {
        for (Child c : children(tree, parentId)) if (name.equals(c.name)) return c.id;
        return null;
    }

    /** Dossier de sauvegarde : {tree, documentId}. Création du sous-dossier par défaut si demandé. */
    // Partoche/Settings : fichiers « ! » (réglages, agenda, temps de travail, journal) ; Partoche/MesNotes : annotations par partition
    static boolean isSettingsFile(String n) { return n != null && n.startsWith("!"); }
    private long pcDataFolder(String name) { long st = pcId("pcSettings"); return isSettingsFile(name) && st >= 0 ? st : pcId("pcSave"); }
    private String[] dataDirFor(String name, boolean create) {
        if (rootMode()) {
            String st = prefs.getString("settingsId", "");
            return new String[]{prefs.getString("rootTree", null), isSettingsFile(name) && !st.isEmpty() ? st : prefs.getString("saveId", null)};
        }
        return dataDir(create);
    }
    private String[] dataDir(boolean create) {
        if (rootMode()) return new String[]{prefs.getString("rootTree", null), prefs.getString("saveId", null)};
        Uri st = saveTreeUri();
        if (st != null) return new String[]{st.toString(), DocumentsContract.getTreeDocumentId(st)};
        Uri tree = treeUri();
        if (tree == null) return null;
        String root = DocumentsContract.getTreeDocumentId(tree);
        String id = findChild(tree, root, DATA_DIR);
        if (id == null && create && canWrite(tree)) {
            sleep(400);
            id = findChild(tree, root, DATA_DIR);   // la liste d'un dossier cloud peut être en retard
            if (id == null) {
                try {
                    Uri d = DocumentsContract.createDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, root), DocumentsContract.Document.MIME_TYPE_DIR, DATA_DIR);
                    if (d != null) {
                        id = DocumentsContract.getDocumentId(d);
                        log("dossier « " + DATA_DIR + " » créé : " + d + " nom affiché=« " + displayName(d) + " »");
                    } else log("✗ création du dossier « " + DATA_DIR + " » : null");
                } catch (Exception e) { log("✗ création du dossier « " + DATA_DIR + " » : " + ex(e)); }
            }
        }
        return id == null ? null : new String[]{tree.toString(), id};
    }

    private String readDoc(Uri tree, String id) {
        try (InputStream in = getContentResolver().openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, id))) {
            if (in == null) return null;
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384]; int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        } catch (Exception e) { return null; }
    }

    /** "X.mscz.json" -> motif des copies pCloud « X.mscz [conflicted].json », « X.mscz [conflicted 2].json » */
    static boolean isConflictOf(String candidate, String name) {
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        return candidate.matches(java.util.regex.Pattern.quote(stem) + " \\[conflicted( \\d+)?\\]( \\(\\d+\\))?" + java.util.regex.Pattern.quote(ext));
    }

    private static long updatedOf(String json) {
        try { return new JSONObject(json).optLong("updated", 0); } catch (Exception e) { return -1; }
    }

    /** Lit le fichier ; s'il existe des copies « [conflicted] », renvoie la plus récente (champ updated). */
    private String readDataImpl(String name) {
        if (pcMode()) {
            try {
                JSONObject f = pcFiles(pcDataFolder(name)).get(name);
                return f == null ? "" : new String(pc().download(f.getLong("fileid")), "UTF-8");
            } catch (Exception e) { log("✗ pCloud, lecture « " + name + " » : " + ex(e)); return ""; }
        }
        String[] d = dataDirFor(name, false);
        if (d == null) return "";
        Uri tree = Uri.parse(d[0]);
        String best = null; long bestU = Long.MIN_VALUE;
        for (Child c : children(tree, d[1])) {
            if (!c.name.equals(name) && !isConflictOf(c.name, name)) continue;
            String t = readDoc(tree, c.id);
            if (t == null || t.isEmpty()) { log("lecture « " + c.name + " » : vide / pas encore disponible"); continue; }
            long u = updatedOf(t);
            if (u > bestU) { bestU = u; best = t; }
        }
        return best == null ? "" : best;
    }

    /** {exists, conflicts, mtime} */
    private String statDataImpl(String name) {
        JSONObject o = new JSONObject();
        if (pcMode()) {
            try {
                JSONObject f = pcFiles(pcDataFolder(name)).get(name);
                o.put("exists", f != null); o.put("conflicts", 0); o.put("mtime", f == null ? 0 : PCloud.parseDate(f.optString("modified")));
            } catch (Exception ignored) { }
            return o.toString();
        }
        try {
            String[] d = dataDirFor(name, false);
            boolean ex = false; int conf = 0; long mt = 0;
            if (d != null) for (Child c : children(Uri.parse(d[0]), d[1])) {
                if (c.name.equals(name)) { ex = true; mt = c.mtime; }
                else if (isConflictOf(c.name, name)) conf++;
            }
            o.put("exists", ex); o.put("conflicts", conf); o.put("mtime", mt);
        } catch (Exception ignored) { }
        return o.toString();
    }

    /** Liste des fichiers du dossier de sauvegarde : [{name, mtime, size}] */
    private String listDataImpl() {
        JSONArray arr = new JSONArray();
        if (pcMode()) {
            try {
                java.util.List<JSONObject> all = new java.util.ArrayList<>(pcFiles(pcId("pcSave")).values());
                if (pcId("pcSettings") >= 0 && pcId("pcSettings") != pcId("pcSave")) all.addAll(pcFiles(pcId("pcSettings")).values());
                for (JSONObject f : all)
                    arr.put(new JSONObject().put("name", f.getString("name")).put("mtime", PCloud.parseDate(f.optString("modified"))).put("size", f.optLong("size")));
            } catch (Exception e) { log("✗ pCloud, liste du dossier élève : " + ex(e)); }
            return arr.toString();
        }
        String[] d = dataDir(false);
        if (d == null) return "[]";
        java.util.List<Child> kids = children(Uri.parse(d[0]), d[1]);
        if (rootMode() && !prefs.getString("settingsId", "").isEmpty()) kids.addAll(children(Uri.parse(d[0]), prefs.getString("settingsId", "")));
        for (Child c : kids) {
            try {
                JSONObject o = new JSONObject();
                o.put("name", c.name); o.put("mtime", c.mtime); o.put("size", c.size);
                arr.put(o);
            } catch (Exception ignored) { }
        }
        return arr.toString();
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    private String displayName(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return null;
    }

    /** Une tentative : ouvre (ou crée si absent) puis écrit, puis relit pour vérifier. */
    private static String ex(Throwable e) { return e == null ? "null" : e.getClass().getSimpleName() + ": " + e.getMessage(); }

    /** Une tentative : ouvre (ou crée si absent) puis écrit. Tout est tracé dans le journal. */
    private String writeOnce(String name, String content) {
        long t0 = System.currentTimeMillis();
        log("ÉCRITURE « " + name + " » (" + content.length() + " car.)");
        if (pcMode()) {
            try {
                PCloud p = pc();
                JSONObject up = p.upload(pcDataFolder(name), name, content.getBytes("UTF-8"));
                // vérification : on relit le fichier enregistré et on compare
                JSONArray md = up.optJSONArray("metadata");
                long fid = md != null && md.length() > 0 ? md.getJSONObject(0).optLong("fileid", -1) : -1;
                if (fid >= 0 && !"!Log.txt".equals(name)) {
                    String back = new String(p.download(fid), "UTF-8");
                    if (!back.equals(content)) { log("  ✗ relecture différente (" + back.length() + " / " + content.length() + " car.)"); return "relecture différente"; }
                    log("  ✓ envoyé à pCloud et relu en " + (System.currentTimeMillis() - t0) + " ms");
                } else log("  ✓ envoyé à pCloud en " + (System.currentTimeMillis() - t0) + " ms");
                return null;
            } catch (Exception e) { log("  ✗ pCloud : " + ex(e)); return "pCloud : " + e.getMessage(); }
        }
        String[] d = dataDirFor(name, true);
        if (d == null) { log("  ✗ dossier de sauvegarde introuvable / non créé (tree=" + treeUri() + ", saveTree=" + saveTreeUri() + ")"); return "dossier de sauvegarde inaccessible"; }
        Uri tree = Uri.parse(d[0]);
        log("  dossier : tree=" + tree + " (fournisseur " + tree.getAuthority() + "), dirId=" + d[1]);
        if (!canWrite(tree)) { log("  ✗ pas de permission d'écriture persistante sur ce dossier"); return "pas d'accès en écriture"; }
        ContentResolver cr = getContentResolver();
        java.util.List<Child> list = children(tree, d[1]);
        for (int k = 0; k < 3 && list.isEmpty(); k++) { sleep(700); list = children(tree, d[1]); }   // liste pCloud parfois vide/en retard
        StringBuilder names = new StringBuilder();
        for (Child c : list) { if (names.length() < 900) names.append(c.name).append(" [").append(c.size).append("] | "); }
        log("  contenu du dossier (" + list.size() + ") : " + names);
        String id = null; Child cur = null;
        for (Child c : list) if (name.equals(c.name)) { id = c.id; cur = c; }
        if (id == null) { sleep(600); id = findChild(tree, d[1], name); if (id != null) log("  trouvé au 2e essai de liste"); }
        Long prevSize = lastSize.containsKey(name) ? lastSize.get(name) : (prefs.contains("sz:" + name) ? prefs.getLong("sz:" + name, -1) : null);
        if (cur != null && prevSize != null && cur.size != prevSize) log("  ℹ taille annoncée " + cur.size + " ≠ " + prevSize + " écrits la dernière fois (le fichier a changé ailleurs, ou pCloud est en retard)");
        Uri fu;
        if (id != null) {
            fu = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            log("  fichier existant : " + fu);
        } else {
            try {
                String mime = name.endsWith(".txt") ? "text/plain" : "application/json";
                fu = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, d[1]), mime, name);
            } catch (Exception e) { log("  ✗ createDocument : " + ex(e)); return "création impossible (" + ex(e) + ")"; }
            if (fu == null) { log("  ✗ createDocument a renvoyé null"); return "création impossible"; }
            String got = displayName(fu);
            log("  créé : " + fu + " nom affiché=« " + got + " »");
            if (got != null && !got.equals(name)) {
                // Android/pCloud a donné un autre nom : un fichier du même nom existait déjà -> on retire notre copie
                try { boolean del = DocumentsContract.deleteDocument(cr, fu); log("  nom différent -> copie supprimée=" + del); } catch (Exception e) { log("  ✗ suppression copie : " + ex(e)); }
                return "fichier déjà présent (" + got + ")";
            }
        }
        byte[] bytes;
        try { bytes = content.getBytes("UTF-8"); } catch (Exception e) { return "encodage"; }
        String how = null;
        // 1) flux « wt » (le plus compatible avec les fournisseurs cloud)
        try (java.io.OutputStream out = cr.openOutputStream(fu, "wt")) {
            if (out != null) { out.write(bytes); out.flush(); how = "openOutputStream(wt)"; }
            else log("  openOutputStream(wt) = null");
        } catch (Exception e) { log("  ✗ openOutputStream(wt) : " + ex(e)); how = null; }
        // 2) descripteur « rwt »
        if (how == null) {
            try (android.os.ParcelFileDescriptor pfd = cr.openFileDescriptor(fu, "rwt")) {
                if (pfd != null) { writeAll(pfd, bytes); how = "openFileDescriptor(rwt)"; }
            } catch (Exception e) { log("  ✗ openFileDescriptor(rwt) : " + ex(e)); }
        }
        // 3) descripteur « rw » + troncature
        if (how == null) {
            try (android.os.ParcelFileDescriptor pfd = cr.openFileDescriptor(fu, "rw")) {
                if (pfd != null) { writeAll(pfd, bytes); how = "openFileDescriptor(rw)+truncate"; }
            } catch (Exception e) { log("  ✗ openFileDescriptor(rw) : " + ex(e)); }
        }
        if (how == null) { log("  ✗ aucune méthode d'écriture n'a fonctionné"); return "écriture refusée"; }
        log("  ✓ écrit via " + how + " en " + (System.currentTimeMillis() - t0) + " ms");
        lastSize.put(name, (long) bytes.length);
        prefs.edit().putLong("sz:" + name, bytes.length).apply();
        // contrôle : pCloud a-t-il mis NOTRE contenu dans une copie « [conflicted] » ?
        // (on compare le contenu, pas seulement le nom : une liste en retard ne doit pas nous tromper)
        long ourUpdated = updatedOf(content);
        boolean cloud = !"com.android.externalstorage.documents".equals(tree.getAuthority());
        if (!cloud) { log("  (dossier de la tablette : pas de contrôle de conflit nécessaire)"); return null; }
        for (int k = 0; k < 1; k++) {
            sleep(1200);
            for (Child c : children(tree, d[1])) {
                if (name.equals(c.name) && k == 0) log("  taille annoncée par le fournisseur : " + c.size + " (écrit " + bytes.length + ")");
                if (isConflictOf(c.name, name) && c.size == bytes.length) {
                    String cc = readDoc(tree, c.id);
                    if (cc != null && cc.equals(content)) {
                        log("  ⚠ pCloud a mis notre contenu dans « " + c.name + " » — on le remet à la place du fichier");
                        fixConflict(tree, d[1], name, c, content);
                        return null;
                    }
                }
            }
        }
        // anciennes copies « [conflicted] » : supprimées seulement si elles sont plus anciennes que ce qu'on vient d'écrire
        for (Child c : children(tree, d[1])) {
            if (!isConflictOf(c.name, name)) continue;
            String cc = readDoc(tree, c.id);
            long cu = cc == null ? -1 : updatedOf(cc);
            if (name.endsWith(".txt") || (cc != null && cu >= 0 && cu <= ourUpdated)) {
                try { boolean del = DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, c.id)); log("  ancienne copie « " + c.name + " » (plus ancienne) supprimée=" + del); }
                catch (Exception e) { log("  ✗ suppression « " + c.name + " » : " + ex(e)); }
            } else log("  copie « " + c.name + " » gardée (plus récente ou illisible)");
        }
        return null;
    }

    /** pCloud a mis NOTRE contenu dans une copie « [conflicted] » : on supprime l'ancien fichier et on renomme la copie. */
    private void fixConflict(Uri tree, String dirId, String name, Child copy, String content) {
        ContentResolver cr = getContentResolver();
        String mainId = findChild(tree, dirId, name);
        try {
            if (mainId != null) { boolean del = DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, mainId)); log("    ancien fichier supprimé=" + del); }
            Uri r = DocumentsContract.renameDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, copy.id), name);
            log("    copie renommée en « " + name + " » : " + (r != null));
            if (r != null) { lastSize.put(name, (long) content.getBytes("UTF-8").length); return; }
        } catch (Exception e) { log("    ✗ renommage : " + ex(e)); }
        // si le renommage échoue : on recrée le fichier et on supprime la copie
        try {
            Uri fu = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, dirId), "application/json", name);
            if (fu != null) {
                try (java.io.OutputStream out = cr.openOutputStream(fu, "wt")) { out.write(content.getBytes("UTF-8")); }
                DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, copy.id));
                lastSize.put(name, (long) content.getBytes("UTF-8").length);
                log("    fichier recréé, copie supprimée");
            }
        } catch (Exception e) { log("    ✗ recréation : " + ex(e)); }
    }

    // ---- journal ----
    private final Object logLock = new Object();
    private java.io.File logFile() { return new java.io.File(getFilesDir(), "mcsz-log.txt"); }

    void log(String msg) {
        synchronized (logLock) {
            try {
                java.io.File f = logFile();
                if (f.length() > 400_000) {   // on garde la fin
                    byte[] all = java.nio.file.Files.readAllBytes(f.toPath());
                    byte[] tail = java.util.Arrays.copyOfRange(all, all.length - 200_000, all.length);
                    java.nio.file.Files.write(f.toPath(), tail);
                }
                String line = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.FRANCE).format(new java.util.Date()) + "  " + msg + "\n";
                try (java.io.FileOutputStream o = new java.io.FileOutputStream(f, true)) { o.write(line.getBytes("UTF-8")); }
            } catch (Exception ignored) { }
        }
    }

    String readLog() {
        synchronized (logLock) {
            try { return new String(java.nio.file.Files.readAllBytes(logFile().toPath()), "UTF-8"); } catch (Exception e) { return ""; }
        }
    }

    void logEnvironment() {
        try {
            log("===== Partoche And Prof " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName
                    + " · Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ") · " + Build.MANUFACTURER + " " + Build.MODEL);
            log("dossier partitions : " + treeUri() + (treeUri() != null ? " écriture=" + canWrite(treeUri()) : ""));
            log("dossier sauvegarde : " + (saveTreeUri() == null ? "(par défaut : partitions/" + DATA_DIR + ")" : saveTreeUri() + " écriture=" + canWrite(saveTreeUri())));
            for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions())
                log("permission : " + p.getUri() + " lecture=" + p.isReadPermission() + " écriture=" + p.isWritePermission());
        } catch (Exception ignored) { }
    }

    private static void writeAll(android.os.ParcelFileDescriptor pfd, byte[] bytes) throws java.io.IOException {
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(pfd.getFileDescriptor())) {
            java.nio.channels.FileChannel ch = fos.getChannel();
            ch.position(0);
            ch.write(java.nio.ByteBuffer.wrap(bytes));
            ch.truncate(bytes.length);
            ch.force(true);
        }
    }

    // ---- file d'attente d'écriture ----
    private static final long MIN_GAP = 8000;   // écart mini entre 2 écritures du même fichier
    private volatile long lastAutoLog = 0;
    private final java.util.Map<String, Long> lastSize = new java.util.concurrent.ConcurrentHashMap<>();
    private final Object qLock = new Object();
    private final java.util.LinkedHashMap<String, String> pending = new java.util.LinkedHashMap<>();
    private final java.util.Map<String, Long> lastWriteAt = new java.util.HashMap<>();
    private Thread worker;

    private void queueWrite(String name, String content) {
        synchronized (qLock) {
            pending.put(name, content);
            qLock.notifyAll();
            if (worker == null) {
                worker = new Thread(this::workLoop, "mcsz-writer");
                worker.setDaemon(true);
                worker.start();
            }
        }
        saveState("saving", name, 0, null);
    }

    private void workLoop() {
        while (true) {
            String name, content;
            synchronized (qLock) {
                while (true) {
                    if (pending.isEmpty()) { try { qLock.wait(); } catch (InterruptedException e) { return; } continue; }
                    long now = System.currentTimeMillis(), wait = Long.MAX_VALUE;
                    String pick = null;
                    for (String n : pending.keySet()) {
                        long w = (lastWriteAt.containsKey(n) ? lastWriteAt.get(n) + MIN_GAP : 0) - now;
                        if (w <= 0) { pick = n; break; }
                        wait = Math.min(wait, w);
                    }
                    if (pick != null) { name = pick; content = pending.remove(pick); break; }
                    try { qLock.wait(wait); } catch (InterruptedException e) { return; }
                }
            }
            synchronized (qLock) { if (pending.containsKey(name)) content = pending.remove(name); }
            int attempt = 0;
            while (true) {
                String err;
                try { err = writeOnce(name, content); } catch (Exception e) { err = String.valueOf(e.getMessage()); }
                if (err == null) {
                    synchronized (qLock) { lastWriteAt.put(name, System.currentTimeMillis()); }
                    saveState("saved", name, attempt, null);
                    break;
                }
                attempt++;
                log("  → échec « " + name + " » : " + err + " — essai n°" + attempt + ", on réessaie");
                saveState("retry", name, attempt, err);
                sleep(Math.min(30000, 1000L << Math.min(attempt - 1, 5)));   // 1, 2, 4, 8, 16, 30 s…
                synchronized (qLock) { if (pending.containsKey(name)) content = pending.remove(name); }   // on prend la version la plus récente
            }
        }
    }

    private void saveState(String state, String name, int attempt, String err) {
        if ("!Log.txt".equals(name) && !"retry".equals(state)) return;   // le journal n'affiche rien
        try {
            JSONObject o = new JSONObject();
            int n; synchronized (qLock) { n = pending.size() - (pending.containsKey("!Log.txt") ? 1 : 0); }
            o.put("state", state); o.put("name", name); o.put("attempt", attempt); o.put("pending", n);
            if (err != null) o.put("error", err);
            callJs("window.__native && window.__native.onSaveState && window.__native.onSaveState(" + JSONObject.quote(o.toString()) + ")");
        } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ bouton retour
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.__native && window.__native.onBack) ? window.__native.onBack() : false", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.__native && window.__native.onResume && window.__native.onResume()", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.evaluateJavascript("window.__native && window.__native.onPause && window.__native.onPause()", null);
    }

    // ------------------------------------------------------------------ pont JS
    private class Bridge {
        // partage avec la prof : config pour la vérification en arrière-plan (notification)
        @JavascriptInterface
        public void setShare(String json) {
            prefs.edit().putString("share", json == null ? "" : json).apply();
            try {
                if (json != null && !json.isEmpty()) {
                    org.json.JSONObject o = new org.json.JSONObject(json);
                    if (o.has("seen")) prefs.edit().putString("guestSeen", o.getJSONObject("seen").toString()).apply();
                }
            } catch (Exception ignored) { }
            boolean on = json != null && !json.isEmpty();
            GuestCheckJob.schedule(MainActivity.this, on);
            if (on && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                runOnUiThread(() -> requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 46));
        }
        @JavascriptInterface
        public void setGuestSeen(String json) {
            prefs.edit().putString("guestSeen", json == null ? "{}" : json).apply();
            ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(7302);
        }
        /** Range tout de suite les dossiers « Files from … » ; prévient la page si quelque chose a bougé */
        @JavascriptInterface
        public void tidyNow() {
            new Thread(() -> {
                int before = tidyChanges;
                String ns = prefs.getString("newScores", "[]");
                tidyDrops();
                if (tidyChanges != before || !ns.equals(prefs.getString("newScores", "[]"))) callJs("window.__native && window.__native.onTidy && window.__native.onTidy()");
            }).start();
        }
        @JavascriptInterface
        public void checkGuestNow() { new Thread(() -> { try { GuestCheckJob.check(MainActivity.this); } catch (Throwable ignored) { } }).start(); }

        /** Appel pCloud asynchrone : le résultat revient par window.__native.onPc(id, json) */
        @JavascriptInterface
        public void pcCall(String id, String action, String args) {
            if ("weblogin".equals(action)) { pcWebLogin(id); return; }
            if ("oauth".equals(action)) {
                try { pcOAuth(id, new JSONObject(args).getString("clientId")); } catch (Exception e) { callJs("window.__native && window.__native.onPc && window.__native.onPc(" + JSONObject.quote(id) + ",'{\"error\":\"client\"}')"); }
                return;
            }
            new Thread(() -> {
                String res;
                try { res = pcReqResult(action, new JSONObject(args == null || args.isEmpty() ? "{}" : args)); }
                catch (PCloud.Err e) {
                    try { res = new JSONObject().put("error", e.getMessage()).put("code", e.code).toString(); } catch (Exception x) { res = "{\"error\":\"erreur\"}"; }
                    log("✗ pCloud " + action + " : " + e.code + " " + e.getMessage());
                } catch (Exception e) {
                    try { res = new JSONObject().put("error", e.getMessage() == null ? e.toString() : e.getMessage()).toString(); } catch (Exception x) { res = "{\"error\":\"erreur\"}"; }
                    log("✗ pCloud " + action + " : " + ex(e));
                }
                callJs("window.__native && window.__native.onPc && window.__native.onPc(" + JSONObject.quote(id) + "," + JSONObject.quote(res) + ")");
            }).start();
        }

        /** Partager un texte (liens pour le prof) via WhatsApp, mail… */
        @JavascriptInterface
        public void shareText(String text) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                try { startActivity(Intent.createChooser(i, "Envoyer à mon prof")); } catch (Exception ignored) { }
            });
        }

        @JavascriptInterface
        public void pickFolder() { pick(REQ_FOLDER); }

        @JavascriptInterface
        public void pickRootFolder() { pick(REQ_ROOT); }

        @JavascriptInterface
        public void pickNewRootFolder() { pick(REQ_ROOT_NEW); }

        @JavascriptInterface
        public void pickSaveFolder() { pick(REQ_SAVE); }

        @JavascriptInterface
        public void resetSaveFolder() { prefs.edit().remove("saveTree").apply(); }

        @JavascriptInterface
        public String getInfo() { return infoJson(); }

        private void pick(int req) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try { startActivityForResult(i, req); } catch (Exception ignored) { }
            });
        }

        @JavascriptInterface
        public void requestFiles() { scanAsync(); }

        @JavascriptInterface
        public String readData(String name) { return readDataImpl(name); }

        @JavascriptInterface
        public String listData() { return listDataImpl(); }

        @JavascriptInterface
        public String statData(String name) { return statDataImpl(name); }

        private Uri uriFromUrl(String url) {
            try {
                String enc = Uri.parse(url).getEncodedPath().substring("/doc/".length());
                return Uri.parse(URLDecoder.decode(enc, "UTF-8"));
            } catch (Exception e) { return null; }
        }

        /** Renomme une partition ; renvoie sa nouvelle URL (ou "" si échec) */
        @JavascriptInterface
        public String renameDoc(String url, String newName) {
            if (url != null && url.contains("/pc/")) {
                try {
                    String[] seg = Uri.parse(url).getPath().substring(4).split("/");
                    pc().rename(Long.parseLong(seg[0]), newName);
                    return url;
                } catch (Exception e) { log("✗ pCloud, renommage partition : " + ex(e)); return ""; }
            }
            Uri u = uriFromUrl(url);
            if (u == null) return "";
            try {
                Uri r = DocumentsContract.renameDocument(getContentResolver(), u, newName);
                log("renommage partition « " + newName + " » : " + (r != null));
                return r == null ? "" : docUrl(r);
            } catch (Exception e) { log("✗ renommage partition : " + ex(e)); return ""; }
        }

        @JavascriptInterface
        public boolean deleteDoc(String url) {
            if (url != null && url.contains("/pc/")) {
                try { pc().delete(Long.parseLong(Uri.parse(url).getPath().substring(4).split("/")[0])); return true; }
                catch (Exception e) { log("✗ pCloud, suppression partition : " + ex(e)); return false; }
            }
            Uri u = uriFromUrl(url);
            if (u == null) return false;
            try { boolean ok = DocumentsContract.deleteDocument(getContentResolver(), u); log("suppression partition " + u + " : " + ok); return ok; }
            catch (Exception e) { log("✗ suppression partition : " + ex(e)); return false; }
        }

        /** Renomme un fichier du dossier de sauvegarde (annotations d'une partition renommée) */
        @JavascriptInterface
        public boolean renameData(String oldName, String newName) {
            if (pcMode()) {
                try { JSONObject f = pcFiles(pcDataFolder(oldName)).get(oldName); if (f == null) return false; pc().rename(f.getLong("fileid"), newName); return true; }
                catch (Exception e) { log("✗ pCloud, renommage annotations : " + ex(e)); return false; }
            }
            String[] d = dataDirFor(oldName, false);
            if (d == null) return false;
            Uri tree = Uri.parse(d[0]);
            String id = findChild(tree, d[1], oldName);
            if (id == null) return false;
            try { return DocumentsContract.renameDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, id), newName) != null; }
            catch (Exception e) { log("✗ renommage annotations : " + ex(e)); return false; }
        }

        /** Partition renommée : les envois du prof (« <Prof> - <ancien>.mscz - <date>.json » dans Prof) suivent */
        @JavascriptInterface
        public int renameProfDrops(String oldScore, String newScore) {
            int n = 0;
            try {
                String mid = " - " + oldScore + " - ";
                if (pcMode()) {
                    PCloud p = pc();
                    JSONArray cs = p.listFolder(pcId("pcProf"), false, false).optJSONArray("contents");
                    if (cs != null) for (int i = 0; i < cs.length(); i++) {
                        JSONObject f = cs.getJSONObject(i); String nm = f.optString("name");
                        if (f.optBoolean("isfolder") || !nm.contains(mid)) continue;
                        try { p.rename(f.getLong("fileid"), nm.replace(mid, " - " + newScore + " - ")); n++; } catch (Exception e) { log("renommage envoi prof : " + ex(e)); }
                    }
                } else if (rootMode()) {
                    Uri tree = treeUri(); String prof = prefs.getString("profId", "");
                    if (tree != null && !prof.isEmpty()) for (Child c : children(tree, prof)) {
                        if (c.dir || !c.name.contains(mid)) continue;
                        try { if (DocumentsContract.renameDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, c.id), c.name.replace(mid, " - " + newScore + " - ")) != null) n++; } catch (Exception e) { log("renommage envoi prof : " + ex(e)); }
                    }
                }
            } catch (Exception e) { log("renommage des envois du prof : " + ex(e)); }
            log("partition renommée : " + n + " envoi(s) du prof renommé(s)");
            return n;
        }

        @JavascriptInterface
        public boolean deleteData(String name) {
            if (pcMode()) {
                try { JSONObject f = pcFiles(pcDataFolder(name)).get(name); if (f == null) return false; pc().delete(f.getLong("fileid")); return true; }
                catch (Exception e) { log("✗ pCloud, suppression annotations : " + ex(e)); return false; }
            }
            String[] d = dataDirFor(name, false);
            if (d == null) return false;
            Uri tree = Uri.parse(d[0]);
            String id = findChild(tree, d[1], name);
            if (id == null) return false;
            try { return DocumentsContract.deleteDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, id)); }
            catch (Exception e) { log("✗ suppression annotations : " + ex(e)); return false; }
        }

        @JavascriptInterface
        public void queueData(String name, String content) { queueWrite(name, content); }

        @JavascriptInterface
        public void log(String msg) { MainActivity.this.log("[appli] " + msg); }

        @JavascriptInterface
        public String getLog() { String l = readLog(); return l.length() > 60000 ? l.substring(l.length() - 60000) : l; }

        @JavascriptInterface
        public void clearLog() { synchronized (logLock) { logFile().delete(); } logEnvironment(); }

        /** Exporte le journal où l'utilisateur veut (Téléchargements…) */
        @JavascriptInterface
        public void exportLog() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TITLE, "Partoche And Prof - journal.txt");
                try { startActivityForResult(i, REQ_EXPORT_LOG); } catch (Exception ignored) { }
            });
        }

        /** Copie le journal dans le dossier de sauvegarde (à côté de !Settings.json) */
        @JavascriptInterface
        public void setAutoLog(boolean on) { prefs.edit().putBoolean("autoLog", on).apply(); }

        @JavascriptInterface
        public boolean getAutoLog() { return prefs.getBoolean("autoLog", true); }

        @JavascriptInterface
        public void copyLogToSave() { queueWrite("!Log.txt", readLog()); }

        /** Journal automatique : au plus toutes les 3 min, appelé en quittant une partition / l'appli */
        @JavascriptInterface
        public void autoLogTick() {
            if (!prefs.getBoolean("autoLog", true)) return;
            long now = System.currentTimeMillis();
            if (now - lastAutoLog < 180000) return;
            lastAutoLog = now;
            queueWrite("!Log.txt", readLog());
        }


        @JavascriptInterface
        public String takePendingOpen() {
            String p = pendingOpen;
            pendingOpen = null;
            return p == null ? "" : p;
        }

        // volume « média » de la tablette (le même que les boutons physiques pendant la lecture)
        @JavascriptInterface
        public String getMediaVolume() {
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                return "{\"cur\":" + am.getStreamVolume(AudioManager.STREAM_MUSIC) + ",\"max\":" + am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) + "}";
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public void setMediaVolume(int v) {
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(0, Math.min(max, v)), 0);
            } catch (Exception e) { }
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
