/* =====================================================================
 * Seal IPTV for Fire TV — PlayerActivity.java   (Android's own player)
 * ---------------------------------------------------------------------
 * Media3 ExoPlayer: HLS, MPEG-TS, MP4, MKV; hardware HEVC; AC-3 / E-AC-3.
 * Started (and given new streams) by player-tv.js through NativeBridge:
 *   { url, ua, live, start (ms), title, subtitle, avsync (ms), device,
 *     canZap, next (title of the next episode, '' = none), hasNext }
 * Tells player-tv.js (event 'player'): progress / ended / next / zap /
 * avsync / external / error / closed — see player-tv.js.
 *
 * Remote:
 *   OK / ▶❚❚      controls, play / pause        ← →   seek
 *   ↑ ↓ (live)    channel up / down (also CH+ / CH−)
 *   ☰ Menu        audio track, subtitles, audio sync, next episode,
 *                 open in another app
 *   Back          hide the controls, else close
 *
 * AUDIO SYNC: the video is drawn by the clock of the sound. A sink that
 * reports its position <offset> later makes every frame wait <offset> —
 * the picture waits for late (Bluetooth) sound; a negative offset makes
 * the sound wait. Changes apply while playing.
 * ===================================================================== */
package com.sealiptv.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.ForwardingAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.TrackSelectionDialogBuilder;

import org.json.JSONObject;

@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {
    static PlayerActivity instance;

    private static final int ACCENT = Color.parseColor("#3CCF91");
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private PlayerView view;
    private TextView titleView, subView, liveBadge, osd, nextText, errorText;
    private LinearLayout top, nextBox, errorBox;
    private JSONObject cfg = new JSONObject();
    private volatile long offsetUs = 0;      // audio sync (see header)
    private boolean closed = false, retried = false;
    private int nextLeft = 0;

    /* ---------------- layout ---------------- */
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        instance = this;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new PlayerView(this);
        view.setKeepScreenOn(true);
        view.setControllerShowTimeoutMs(4000);
        view.setShowSubtitleButton(true);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));

        top = new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setPadding(dp(28), dp(18), dp(28), dp(30));
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0xCC000000, 0x00000000}));
        titleView = text(22, Color.WHITE, true);
        subView = text(14, 0xFFC9CED6, false);
        top.addView(titleView);
        top.addView(subView);
        root.addView(top, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        liveBadge = text(12, Color.WHITE, true);
        liveBadge.setText("LIVE");
        liveBadge.setPadding(dp(8), dp(2), dp(8), dp(2));
        liveBadge.setBackground(round(0xFFFF6464, 4));
        FrameLayout.LayoutParams lb = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END);
        lb.setMargins(0, dp(22), dp(28), 0);
        root.addView(liveBadge, lb);

        osd = text(16, Color.WHITE, false);
        osd.setPadding(dp(16), dp(8), dp(16), dp(8));
        osd.setBackground(round(0xE6121418, 10));
        osd.setVisibility(View.GONE);
        FrameLayout.LayoutParams ol = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        ol.setMargins(0, dp(80), 0, 0);
        root.addView(osd, ol);

        nextBox = panel();
        nextText = text(16, Color.WHITE, false);
        Button now = button("Play now", true);
        now.setOnClickListener(v -> goNext());
        nextBox.addView(nextText);
        nextBox.addView(now);
        FrameLayout.LayoutParams nl = new FrameLayout.LayoutParams(dp(360), -2, Gravity.BOTTOM | Gravity.END);
        nl.setMargins(0, 0, dp(28), dp(110));
        root.addView(nextBox, nl);

        errorBox = panel();
        errorText = text(16, Color.WHITE, false);
        Button other = button("Open in another app", true);
        other.setOnClickListener(v -> { emit("external", null); finishPlayer(false); });
        Button close = button("Close", false);
        close.setOnClickListener(v -> finishPlayer(true));
        errorBox.addView(errorText);
        errorBox.addView(other);
        errorBox.addView(close);
        root.addView(errorBox, new FrameLayout.LayoutParams(dp(520), -2, Gravity.CENTER));

        setContentView(root);
        view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) vis -> top.setVisibility(vis));
        load(getIntent().getStringExtra("json"));
    }

    /* ---------------- playing ---------------- */
    void load(String json) {
        try { cfg = new JSONObject(json == null ? "{}" : json); } catch (Exception e) { cfg = new JSONObject(); }
        closed = false;
        retried = false;
        nextBox.setVisibility(View.GONE);
        errorBox.setVisibility(View.GONE);
        ui.removeCallbacks(nextTick);
        titleView.setText(cfg.optString("title"));
        subView.setText(cfg.optString("subtitle"));
        liveBadge.setVisibility(cfg.optBoolean("live") ? View.VISIBLE : View.GONE);
        offsetUs = cfg.optLong("avsync", 0) * 1000L;
        start(cfg.optLong("start", 0));
    }

    private void start(long startMs) {
        if (player != null) player.release();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(cfg.optString("ua", "SealIPTV"))
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000);
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this) {
            @Override
            protected AudioSink buildAudioSink(@NonNull Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
                AudioSink sink = super.buildAudioSink(context, enableFloatOutput, enableAudioTrackPlaybackParams);
                return sink == null ? null : new ForwardingAudioSink(sink) {
                    @Override public long getCurrentPositionUs(boolean sourceEnded) {
                        long p = super.getCurrentPositionUs(sourceEnded);
                        return p == AudioSink.CURRENT_POSITION_NOT_SET ? p : Math.max(0, p - offsetUs);
                    }
                };
            }
        }.setEnableDecoderFallback(true);
        player = new ExoPlayer.Builder(this, renderers).setMediaSourceFactory(new DefaultMediaSourceFactory(http)).build();
        view.setPlayer(player);
        String url = cfg.optString("url");
        MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
        String path = Uri.parse(url).getPath() == null ? "" : Uri.parse(url).getPath().toLowerCase();
        if (path.endsWith(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(item.build(), startMs > 0 ? startMs : C.TIME_UNSET);
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) ended();
            }
            @Override public void onPlayerError(@NonNull PlaybackException e) { failed(e); }
        });
        player.prepare();
        player.play();
        ui.removeCallbacks(progressTick);
        ui.postDelayed(progressTick, 5000);
    }

    private final Runnable progressTick = new Runnable() {
        @Override public void run() {
            if (player == null || closed) return;
            if (player.isPlaying()) emit("progress", null);
            ui.postDelayed(this, 5000);
        }
    };

    private void ended() {
        emit("ended", null);
        String next = cfg.optString("next", "");
        if (next.isEmpty()) return;          // player-tv.js closes us
        nextLeft = 10;
        nextText.setText("Next episode in " + nextLeft + " s\n" + next);
        nextBox.setVisibility(View.VISIBLE);
        nextBox.getChildAt(1).requestFocus();
        ui.postDelayed(nextTick, 1000);
    }

    private final Runnable nextTick = new Runnable() {
        @Override public void run() {
            if (nextBox.getVisibility() != View.VISIBLE) return;
            if (--nextLeft <= 0) { goNext(); return; }
            nextText.setText("Next episode in " + nextLeft + " s\n" + cfg.optString("next"));
            ui.postDelayed(this, 1000);
        }
    };

    private void goNext() {
        ui.removeCallbacks(nextTick);
        nextBox.setVisibility(View.GONE);
        emit("next", null);
    }

    private void failed(PlaybackException e) {
        // a live stream that hiccups: one quiet retry
        if (cfg.optBoolean("live") && !retried && e.errorCode >= 2000 && e.errorCode < 3000) {
            retried = true;
            showOsd("Reconnecting…");
            ui.postDelayed(() -> { if (!closed) start(0); }, 1500);
            return;
        }
        String why = e.getErrorCodeName().replace("ERROR_CODE_", "").replace('_', ' ').toLowerCase();
        errorText.setText("This can't be played here (" + why + ").\nIt may be offline, or another app may play it.");
        errorBox.setVisibility(View.VISIBLE);
        errorBox.getChildAt(1).requestFocus();
        try { emit("error", new JSONObject().put("message", why).toString()); } catch (Exception ignored) { }
    }

    /* ---------------- commands from player-tv.js ---------------- */
    void command(String json) {
        try {
            JSONObject c = new JSONObject(json);
            switch (c.optString("cmd")) {
                case "close": finishPlayer(true); break;
                case "avsync": offsetUs = c.optLong("ms") * 1000L; break;
                case "subtitle": subView.setText(c.optString("text")); break;
            }
        } catch (Exception ignored) { }
    }

    /* ---------------- remote ---------------- */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        boolean panel = errorBox.getVisibility() == View.VISIBLE || nextBox.getVisibility() == View.VISIBLE;
        if (k == KeyEvent.KEYCODE_BACK) {
            if (!down) return true;
            if (nextBox.getVisibility() == View.VISIBLE) { ui.removeCallbacks(nextTick); nextBox.setVisibility(View.GONE); finishPlayer(true); return true; }
            if (errorBox.getVisibility() == View.VISIBLE) { finishPlayer(true); return true; }
            if (view.isControllerFullyVisible()) { view.hideController(); return true; }
            finishPlayer(true);
            return true;
        }
        if (k == KeyEvent.KEYCODE_MENU) { if (down) menu(); return true; }
        if (!panel && cfg.optBoolean("live") && cfg.optBoolean("canZap")) {
            boolean upKey = k == KeyEvent.KEYCODE_CHANNEL_UP || (k == KeyEvent.KEYCODE_DPAD_UP && !view.isControllerFullyVisible());
            boolean downKey = k == KeyEvent.KEYCODE_CHANNEL_DOWN || (k == KeyEvent.KEYCODE_DPAD_DOWN && !view.isControllerFullyVisible());
            if (upKey || downKey) {
                if (down) { showOsd(upKey ? "▲ Previous channel" : "▼ Next channel"); try { emit("zap", new JSONObject().put("dir", upKey ? -1 : 1).toString()); } catch (Exception ignored) { } }
                return true;
            }
        }
        if (panel) return super.dispatchKeyEvent(e);
        return view.dispatchKeyEvent(e) || super.dispatchKeyEvent(e);
    }

    /* ☰ Menu: tracks, audio sync, next episode, another app */
    private void menu() {
        boolean hasNext = cfg.optBoolean("hasNext");
        String[] items = hasNext
                ? new String[]{"Audio track", "Subtitles", "Audio sync (" + sign(offsetUs / 1000) + " ms)", "Next episode", "Open in another app"}
                : new String[]{"Audio track", "Subtitles", "Audio sync (" + sign(offsetUs / 1000) + " ms)", "Open in another app"};
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Seal IPTV")
                .setItems(items, (d, which) -> {
                    String it = items[which];
                    if (it.equals("Audio track")) tracks(C.TRACK_TYPE_AUDIO, "Audio track");
                    else if (it.equals("Subtitles")) tracks(C.TRACK_TYPE_TEXT, "Subtitles");
                    else if (it.startsWith("Audio sync")) avsyncDialog();
                    else if (it.equals("Next episode")) goNext();
                    else { emit("external", null); finishPlayer(false); }
                }).show();
    }

    private void tracks(int type, String title) {
        if (player == null) return;
        new TrackSelectionDialogBuilder(this, title, player, type).setAllowAdaptiveSelections(false).build().show();
    }

    private void avsyncDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(16), dp(24), dp(8));
        TextView value = text(26, Color.WHITE, true);
        value.setGravity(Gravity.CENTER);
        TextView what = text(14, 0xFFA3A9B5, false);
        what.setGravity(Gravity.CENTER);
        TextView dev = text(12, 0xFF6F7685, false);
        dev.setGravity(Gravity.CENTER);
        dev.setText(cfg.optString("device", ""));
        Runnable draw = () -> {
            long ms = offsetUs / 1000;
            value.setText(sign(ms) + " ms");
            what.setText(ms > 0 ? "Picture waits " + ms + " ms for the sound" : ms < 0 ? "Sound waits " + (-ms) + " ms for the picture" : "No delay");
        };
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        for (int step : new int[]{-50, -10, 10, 50}) {
            Button b = button((step > 0 ? "+" : "−") + Math.abs(step), false);
            b.setOnClickListener(v -> { offsetUs = Math.max(-500, Math.min(1000, offsetUs / 1000 + step)) * 1000L; draw.run(); });
            row.addView(b);
        }
        Button zero = button("0", false);
        zero.setOnClickListener(v -> { offsetUs = 0; draw.run(); });
        row.addView(zero);
        box.addView(value);
        box.addView(what);
        box.addView(row);
        box.addView(dev);
        draw.run();
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Audio sync")
                .setView(box)
                .setPositiveButton("Done", (d, w) -> { try { emit("avsync", new JSONObject().put("ms", offsetUs / 1000).toString()); } catch (Exception ignored) { } })
                .show();
        row.getChildAt(2).requestFocus();
    }

    /* ---------------- closing ---------------- */
    private void finishPlayer(boolean tell) {
        if (closed) return;
        if (tell) emit("closed", null);
        closed = true;
        ui.removeCallbacksAndMessages(null);
        if (player != null) { player.release(); player = null; }
        finish();
    }

    @Override protected void onStop() { super.onStop(); if (!isChangingConfigurations()) finishPlayer(true); }
    @Override protected void onDestroy() { if (instance == this) instance = null; if (player != null) { player.release(); player = null; } super.onDestroy(); }

    /* ---------------- helpers ---------------- */
    private void emit(String type, String extra) {
        try {
            JSONObject o = extra == null ? new JSONObject() : new JSONObject(extra);
            o.put("type", type);
            if (player != null) {
                o.put("pos", Math.max(0, player.getCurrentPosition()));
                long d = player.getDuration();
                o.put("dur", d == C.TIME_UNSET ? 0 : d);
            }
            if (NativeBridge.current != null) NativeBridge.current.emit("player", o.toString());
        } catch (Exception ignored) { }
    }

    private final Runnable hideOsd = () -> osd.setVisibility(View.GONE);
    private void showOsd(String t) { osd.setText(t); osd.setVisibility(View.VISIBLE); ui.removeCallbacks(hideOsd); ui.postDelayed(hideOsd, 1600); }

    private static String sign(long ms) { return ms > 0 ? "+" + ms : String.valueOf(ms); }
    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }
    private GradientDrawable round(int color, int radius) { GradientDrawable g = new GradientDrawable(); g.setColor(color); g.setCornerRadius(dp(radius)); return g; }

    private TextView text(int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private LinearLayout panel() {
        LinearLayout p = new LinearLayout(this);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setPadding(dp(18), dp(14), dp(18), dp(14));
        p.setBackground(round(0xF0181B21, 12));
        p.setVisibility(View.GONE);
        return p;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? 0xFF062418 : Color.WHITE);
        b.setFocusable(true);
        GradientDrawable normal = round(primary ? ACCENT : 0xFF272C36, 8);
        GradientDrawable focused = round(primary ? 0xFF4EE0A2 : 0xFF3A414E, 8);
        focused.setStroke(dp(3), ACCENT);
        android.graphics.drawable.StateListDrawable bg = new android.graphics.drawable.StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, focused);
        bg.addState(new int[]{}, normal);
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(4), dp(10), dp(4), 0);
        b.setLayoutParams(lp);
        return b;
    }
}
