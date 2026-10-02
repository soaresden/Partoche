package fr.soaresden.msczplayer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.Map;

/**
 * Accès direct à pCloud (API HTTP JSON) avec le compte de l'élève :
 * plus de fournisseur de documents Android, donc plus de copies « conflicted ».
 * Un fichier réécrit garde son nom ; pCloud conserve l'ancienne version dans son historique.
 */
public class PCloud {
    public static final String EU = "https://eapi.pcloud.com", US = "https://api.pcloud.com";
    public String api, auth;
    public boolean oauth;
    static String tfaDiag = "";   // jeton OAuth (connexion via la page pCloud) -> paramètre access_token

    public PCloud(String api, String auth) { this(api, auth, false); }
    public PCloud(String api, String auth, boolean oauth) { this.api = api; this.auth = auth; this.oauth = oauth; }
    String authParam() { return oauth ? "access_token" : "auth"; }

    public static class Err extends Exception {
        public final int code; public final JSONObject res;
        Err(int code, String msg, JSONObject res) { super(msg); this.code = code; this.res = res; }
    }

    static String sha1(String s) {
        try {
            byte[] h = java.security.MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
            StringBuilder b = new StringBuilder(); for (byte x : h) b.append(String.format("%02x", x & 0xff)); return b.toString();
        } catch (Exception e) { return ""; }
    }
    static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; } }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[32768]; int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        return bo.toByteArray();
    }

    static JSONObject post(String base, String method, Map<String, String> params) throws Exception {
        StringBuilder body = new StringBuilder();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if (body.length() > 0) body.append('&');
            body.append(enc(e.getKey())).append('=').append(enc(e.getValue()));
        }
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/" + method).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(60000);
        c.setRequestMethod("POST"); c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
        try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes("UTF-8")); }
        try (InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream()) {
            return new JSONObject(new String(readAll(in), "UTF-8"));
        } finally { c.disconnect(); }
    }

    JSONObject call(String method, Map<String, String> params) throws Exception {
        params.put(authParam(), auth);
        JSONObject r = post(api, method, params);
        int code = r.optInt("result", -1);
        if (code != 0) throw new Err(code, r.optString("error", "erreur pCloud " + code), r);
        return r;
    }

    static Map<String, String> p(String... kv) {
        Map<String, String> m = new java.util.LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    /** Connexion : renvoie {api, auth, email} ; {needTfa, token, api} si la double authentification est active. */
    public static JSONObject login(String email, String password) throws Exception {
        JSONObject first = null;
        StringBuilder trace = new StringBuilder();
        email = email.trim();
        String[] pwds = password.equals(password.trim()) ? new String[]{password} : new String[]{password, password.trim()};
        for (String base : new String[]{EU, US}) for (String pw : pwds) for (int mode = 0; mode < 2; mode++) {
            JSONObject r;
            if (mode == 0) r = post(base, "userinfo", p("getauth", "1", "username", email, "password", pw,
                    "authexpire", "63072000", "authinactiveexpire", "31536000"));
            else {   // connexion « digest » (recommandée par pCloud) : le mot de passe ne circule pas en clair
                JSONObject dg = post(base, "getdigest", p());
                String digest = dg.optString("digest", "");
                if (digest.isEmpty()) continue;
                String pd = sha1(pw + sha1(email.toLowerCase(Locale.ROOT)) + digest);
                r = post(base, "userinfo", p("getauth", "1", "username", email, "digest", digest, "passworddigest", pd,
                        "authexpire", "63072000", "authinactiveexpire", "31536000"));
            }
            int code = r.optInt("result", -1);
            trace.append(base.contains("eapi") ? "EU" : "US").append(mode == 0 ? "" : "d").append(pw == password ? "" : "t").append(' ').append(code).append(' ');
            if (code == 0) return new JSONObject().put("api", base).put("auth", r.getString("auth")).put("email", r.optString("email", email));
            if (code == 2297) {
                String tok = r.optString("token", ""); if (tok.isEmpty()) tok = r.optString("tfatoken", ""); if (tok.isEmpty()) tok = r.optString("tfa_token", "");
                StringBuilder k = new StringBuilder(); for (java.util.Iterator<String> it = r.keys(); it.hasNext(); ) { String x = it.next(); if (!x.contains("token")) k.append(x).append('=').append(String.valueOf(r.opt(x)).replaceAll("[^\\w@.-]", "").substring(0, Math.min(12, String.valueOf(r.opt(x)).replaceAll("[^\\w@.-]", "").length()))).append(' '); else k.append(x).append(' '); }
                tfaDiag = "jeton " + tok.length() + " car. · " + trace.toString().trim() + (base.contains("eapi") ? "d" : "") + " · " + k.toString().trim();
                return new JSONObject().put("needTfa", true).put("token", tok).put("api", base);
            }
            if (first == null || code != 2321) first = r;
        }
        first.put("trace", trace.toString().trim());
        throw new Err(first.optInt("result"), first.optString("error", "connexion impossible") + " [" + trace.toString().trim() + "]", first);
    }

    public static JSONObject tfaLogin(String base, String token, String code) throws Exception {
        code = code.replaceAll("\\s", "");
        // essais : paramètres minimaux d'abord (l'API renvoie « Internal error » avec certains paramètres), puis l'autre serveur
        JSONObject r = null; int c = -1;
        String other = base.contains("eapi") ? US : EU;
        String[][] tries = { { base, "1" }, { base, "0" }, { other, "1" } };
        for (String[] t : tries) {
            Map<String, String> m = p("token", token, "code", code);
            if (t[1].equals("1")) m.put("trustdevice", "1");
            r = post(t[0], "tfa_login", m);
            c = r.optInt("result", -1);
            if (c == 0) { base = t[0]; break; }
            if (c != 5000 && c != 2000 && c != 1000) break;   // code faux, expiré… : inutile d'insister
        }
        if (c != 0) throw new Err(c, r.optString("error", "code refusé") + " [" + tfaDiag + "]", r);
        return new JSONObject().put("api", base).put("auth", r.getString("auth")).put("email", r.optString("email", ""));
    }

    public JSONObject listFolder(long folderId, boolean recursive, boolean noFiles) throws Exception {
        Map<String, String> m = p("folderid", String.valueOf(folderId));
        if (recursive) m.put("recursive", "1");
        if (noFiles) m.put("nofiles", "1");
        return call("listfolder", m).getJSONObject("metadata");
    }

    public long createFolder(long parent, String name) throws Exception {
        return call("createfolderifnotexists", p("folderid", String.valueOf(parent), "name", name)).getJSONObject("metadata").getLong("folderid");
    }

    /** Écrit (ou remplace) un fichier texte : même nom = nouvelle version, l'ancienne reste dans l'historique pCloud. */
    public JSONObject upload(long folderId, String name, byte[] data) throws Exception {
        String boundary = "----partoche" + System.nanoTime();
        String url = api + "/uploadfile?" + authParam() + "=" + enc(auth) + "&folderid=" + folderId + "&nopartial=1&filename=" + enc(name);
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(120000);
        c.setRequestMethod("POST"); c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream o = c.getOutputStream()) {
            o.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + name.replace("\"", "'") + "\"\r\n"
                    + "Content-Type: application/octet-stream\r\n\r\n").getBytes("UTF-8"));
            o.write(data);
            o.write(("\r\n--" + boundary + "--\r\n").getBytes("UTF-8"));
        }
        JSONObject r;
        try (InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream()) {
            r = new JSONObject(new String(readAll(in), "UTF-8"));
        } finally { c.disconnect(); }
        int code = r.optInt("result", -1);
        if (code != 0) throw new Err(code, r.optString("error", "envoi refusé"), r);
        return r;
    }

    public String downloadUrl(long fileId) throws Exception {
        JSONObject r = call("getfilelink", p("fileid", String.valueOf(fileId)));
        return "https://" + r.getJSONArray("hosts").getString(0) + r.getString("path");
    }

    public byte[] download(long fileId) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(downloadUrl(fileId)).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(120000);
        try (InputStream in = c.getInputStream()) { return readAll(in); } finally { c.disconnect(); }
    }

    /** Téléchargement avec cache disque (clé : id + empreinte du fichier). */
    public File downloadCached(File dir, long fileId, String hash) throws Exception {
        dir.mkdirs();
        File f = new File(dir, fileId + "-" + hash);
        if (f.exists() && f.length() > 0) return f;
        byte[] b = download(fileId);
        File tmp = new File(dir, f.getName() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(b); }
        tmp.renameTo(f);
        return f;
    }

    public void rename(long fileId, String newName) throws Exception { call("renamefile", p("fileid", String.valueOf(fileId), "toname", newName)); }
    public void delete(long fileId) throws Exception { call("deletefile", p("fileid", String.valueOf(fileId))); }

    /** Lien de partage (lecture) protégé par mot de passe, sur un dossier. */
    public JSONObject folderPublink(long folderId, String password) throws Exception {
        Map<String, String> m = p("folderid", String.valueOf(folderId));
        if (password != null && !password.isEmpty()) m.put("linkpassword", password);
        try {
            JSONObject r = call("getfolderpublink", m);
            // si le lien existait déjà, pCloud le renvoie tel quel : on (re)met le mot de passe
            if (password != null && !password.isEmpty() && r.has("linkid")) {
                try { call("changepublink", p("linkid", String.valueOf(r.getLong("linkid")), "linkpassword", password)); } catch (Exception ignored) { }
            }
            return r;
        }
        catch (Err e) {
            // lien déjà existant : on le retrouve et on (re)met le mot de passe
            JSONArray links = call("listpublinks", p()).optJSONArray("publinks");
            if (links != null) for (int i = 0; i < links.length(); i++) {
                JSONObject l = links.getJSONObject(i);
                JSONObject md = l.optJSONObject("metadata");
                if (md != null && md.optLong("folderid", -1) == folderId) {
                    if (password != null && !password.isEmpty())
                        call("changepublink", p("linkid", String.valueOf(l.getLong("linkid")), "linkpassword", password));
                    return l;
                }
            }
            throw e;
        }
    }

    /** Lien de dépôt (le prof y envoie ses annotations, sans compte). */
    public JSONObject uploadLink(long folderId, String comment) throws Exception {
        try { return call("createuploadlink", p("folderid", String.valueOf(folderId), "comment", comment)); }
        catch (Err e) {
            JSONArray links = call("listuploadlinks", p()).optJSONArray("uploadlinks");
            if (links != null) for (int i = 0; i < links.length(); i++) {
                JSONObject l = links.getJSONObject(i);
                JSONObject md = l.optJSONObject("metadata");
                if (md != null && md.optLong("folderid", -1) == folderId) return l;
            }
            throw e;
        }
    }

    public JSONObject userInfo() throws Exception { return call("userinfo", p()); }

    static long parseDate(String s) {
        try { return new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss Z", Locale.US).parse(s).getTime(); } catch (Exception e) { return 0; }
    }
}
