/* =====================================================================
 * Seal IPTV for Fire TV — PlayerActivity.java   (Android's own player)
 * ---------------------------------------------------------------------
 * Media3 ExoPlayer: HLS, MPEG-TS, MP4, MKV; hardware HEVC; AC-3 / E-AC-3.
 * Started (and given new streams) by player-tv.js through NativeBridge:
 *   { url, ua, live, start (ms), title, subtitle, avsync (ms), device,
 *     canZap, next (title of the next episode, '' = none), hasNext,
 *     channels [{ id, name, num }] (live; left out = keep the last ones), index }
 * Tells player-tv.js (event 'player'): progress / ended / next / zap /
 * avsync / external / error / closed, and for the channel guide:
 * guide (opened) / epgNeed { ids } / tune { index } / number { num } / last.
 *
 * Remote:
 *   ← →  (films)  skip 10 s; held: faster, to where the bar shows (on release)
 *   OK / ← (live) the channel guide: ↑ ↓, OK = watch, Back / → = close
 *   ↑ ↓ (live)    channel up / down (also CH+ / CH−)
 *   0-9 (live)    channel number; 0 alone (or ⟲ Last) = the channel before
 *   OK / ▶❚❚      controls, play / pause
 *   ☰ Menu        a side panel: audio, subtitles, speed, picture size,
 *                 audio sync, channel guide / next episode, another app
 *   Back          close the guide / panel / controls, else close
 *
 * AUDIO SYNC: the video is drawn by the clock of the sound. A sink that
 * reports its position <offset> later makes every frame wait <offset> —
 * the picture waits for late (Bluetooth) sound; a negative offset makes
 * the sound wait. Changes apply while playing.
 * ===================================================================== */
package com.sealiptv.tv;

import android.app.Activity;
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
import android.widget.AbsListView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.ForwardingAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;

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

    // the channel guide (live): the category's channels, what's on (from player-tv.js)
    private LinearLayout guideBox;
    private ListView guideList;
    private final GuideAdapter guide = new GuideAdapter();
    private JSONArray channels = new JSONArray();
    private int chIndex = -1;
    private final HashMap<String, String[]> onNow = new HashMap<>();   // id -> { now, next }
    private final HashSet<String> asked = new HashSet<>();
    private String digits = "";

    // the ☰ side panel: rows, and sub-lists (Back goes up one)
    private LinearLayout menuBox, menuRows;
    private TextView menuTitle;
    private ScrollView menuScroll;
    private final ArrayList<Runnable> menuUp = new ArrayList<>();
    private long avsyncShown = 0;

    // ← → in films: skip, held = faster; seeks once, on release, to seekTo
    private LinearLayout seekBox;
    private TextView seekText;
    private ProgressBar seekBar;
    private long seekTo = -1;

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

        // the channel guide, on the left over the picture
        guideBox = new LinearLayout(this);
        guideBox.setOrientation(LinearLayout.VERTICAL);
        guideBox.setPadding(dp(14), dp(20), dp(14), dp(14));
        guideBox.setBackground(new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, new int[]{0xF2121418, 0xE6121418}));
        guideBox.setVisibility(View.GONE);
        TextView gt = text(18, Color.WHITE, true);
        gt.setText("Channels");
        gt.setPadding(dp(10), 0, 0, dp(4));
        TextView gh = text(12, 0xFF8B93A1, false);
        gh.setText("OK watch · 0 the channel before · Back close");
        gh.setPadding(dp(10), 0, 0, dp(10));
        guideBox.addView(gt);
        guideBox.addView(gh);
        guideList = new ListView(this);
        guideList.setAdapter(guide);
        guideList.setDivider(null);
        guideList.setSelector(rowBg(true));
        guideList.setDrawSelectorOnTop(false);
        guideList.setItemsCanFocus(false);
        guideList.setOnItemClickListener((p, v, pos, id) -> tune(pos));
        guideList.setOnScrollListener(new AbsListView.OnScrollListener() {
            @Override public void onScrollStateChanged(AbsListView v, int s) { }
            @Override public void onScroll(AbsListView v, int first, int count, int total) { askEpg(first, count); }
        });
        guideList.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> p, View v, int pos, long id) { askEpg(Math.max(0, pos - 4), 10); }
            @Override public void onNothingSelected(android.widget.AdapterView<?> p) { }
        });
        guideBox.addView(guideList, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(guideBox, new FrameLayout.LayoutParams(dp(500), -1, Gravity.START));

        // the ☰ panel, on the right
        menuBox = new LinearLayout(this);
        menuBox.setOrientation(LinearLayout.VERTICAL);
        menuBox.setPadding(dp(16), dp(24), dp(16), dp(16));
        menuBox.setBackground(round(0xF5181B21, 0));
        menuBox.setVisibility(View.GONE);
        menuTitle = text(19, Color.WHITE, true);
        menuTitle.setPadding(dp(12), 0, 0, dp(12));
        menuBox.addView(menuTitle);
        menuScroll = new ScrollView(this);
        menuRows = new LinearLayout(this);
        menuRows.setOrientation(LinearLayout.VERTICAL);
        menuScroll.addView(menuRows);
        menuBox.addView(menuScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(menuBox, new FrameLayout.LayoutParams(dp(420), -1, Gravity.END));

        // skipping in films: where it will go
        seekBox = panel();
        seekBox.setGravity(Gravity.CENTER_HORIZONTAL);
        seekText = text(20, Color.WHITE, true);
        seekText.setGravity(Gravity.CENTER);
        seekBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        seekBar.setMax(1000);
        seekBar.setProgressTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        seekBox.addView(seekText);
        seekBox.addView(seekBar, new LinearLayout.LayoutParams(dp(560), dp(10)));
        FrameLayout.LayoutParams sl = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        sl.setMargins(0, 0, 0, dp(60));
        root.addView(seekBox, sl);

        setContentView(root);
        view.setResizeMode(getSharedPreferences("player", MODE_PRIVATE).getInt("resize", AspectRatioFrameLayout.RESIZE_MODE_FIT));
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
        JSONArray ch = cfg.optJSONArray("channels");
        if (!cfg.optBoolean("live")) channels = new JSONArray();
        else if (ch != null) channels = ch;          // else: the same list as before (a zap in it)
        chIndex = cfg.optInt("index", -1);
        guide.notifyDataSetChanged();
        hideGuide();
        hideMenu();
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
                case "osd": showOsd(c.optString("text")); break;
                case "channels":      // the whole category, for the guide (player-tv.js loads it when the guide opens)
                    channels = c.optJSONArray("channels") == null ? new JSONArray() : c.optJSONArray("channels");
                    chIndex = c.optInt("index", chIndex);
                    if (channels.length() > 1) cfg.put("canZap", true);   // ↑ ↓ through it too
                    guide.notifyDataSetChanged();
                    if (guideBox.getVisibility() == View.VISIBLE && chIndex >= 0) guideList.setSelection(chIndex);
                    break;
                case "epg": {          // what's on: [{ id, now, next }]
                    JSONArray a = c.optJSONArray("items");
                    if (a != null) for (int i = 0; i < a.length(); i++) {
                        JSONObject x = a.optJSONObject(i);
                        if (x != null) onNow.put(x.optString("id"), new String[]{x.optString("now"), x.optString("next")});
                    }
                    guide.notifyDataSetChanged();
                    break;
                }
            }
        } catch (Exception ignored) { }
    }

    /* ---------------- remote ---------------- */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        boolean live = cfg.optBoolean("live");

        // the guide / the ☰ panel have the remote while they're open
        if (guideBox.getVisibility() == View.VISIBLE) {
            if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_DPAD_RIGHT) { if (down) hideGuide(); return true; }
            if (k == KeyEvent.KEYCODE_MENU) { if (down) { hideGuide(); menu(); } return true; }
            if (digit(k)) { if (down) typeDigit(k); return true; }
            return super.dispatchKeyEvent(e);
        }
        if (menuBox.getVisibility() == View.VISIBLE) {
            if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_MENU) { if (down) menuBack(); return true; }
            if (k == KeyEvent.KEYCODE_DPAD_LEFT && menuUp.size() > 1) { if (down) menuBack(); return true; }
            return super.dispatchKeyEvent(e);
        }

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
        if (panel) return super.dispatchKeyEvent(e);
        boolean controls = view.isControllerFullyVisible();

        if (live) {
            // OK / ← : the channel guide · ↑ ↓ / CH± : zap · digits : a channel number · ⟲ / 0 : the one before
            if (!controls && (k == KeyEvent.KEYCODE_DPAD_CENTER || k == KeyEvent.KEYCODE_ENTER || k == KeyEvent.KEYCODE_DPAD_LEFT) && hasGuide()) {
                if (down && e.getRepeatCount() == 0) showGuide();
                return true;
            }
            if (cfg.optBoolean("canZap")) {
                boolean upKey = k == KeyEvent.KEYCODE_CHANNEL_UP || (k == KeyEvent.KEYCODE_DPAD_UP && !controls);
                boolean downKey = k == KeyEvent.KEYCODE_CHANNEL_DOWN || (k == KeyEvent.KEYCODE_DPAD_DOWN && !controls);
                if (upKey || downKey) {
                    if (down) { showOsd(upKey ? "▲ Previous channel" : "▼ Next channel"); try { emit("zap", new JSONObject().put("dir", upKey ? -1 : 1).toString()); } catch (Exception ignored) { } }
                    return true;
                }
            }
            if (k == KeyEvent.KEYCODE_LAST_CHANNEL) { if (down) { showOsd("⟲ The channel before"); emit("last", null); } return true; }
            if (digit(k)) { if (down) typeDigit(k); return true; }
        } else if (!controls && player != null) {
            // films: ← → skip 10 s; held, faster and faster; one seek when let go
            int dir = k == KeyEvent.KEYCODE_DPAD_RIGHT || k == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD ? 1 : k == KeyEvent.KEYCODE_DPAD_LEFT || k == KeyEvent.KEYCODE_MEDIA_REWIND ? -1 : 0;
            if (dir != 0) {
                if (down) {
                    long dur = player.getDuration();
                    if (seekTo < 0) seekTo = player.getCurrentPosition();
                    int r = e.getRepeatCount();
                    long step = r < 6 ? 10000 : r < 20 ? 30000 : r < 40 ? 60000 : 120000;
                    seekTo = Math.max(0, seekTo + dir * step);
                    if (dur != C.TIME_UNSET && dur > 0) seekTo = Math.min(dur - 1000, seekTo);
                    showSeek(dir, dur);
                } else if (seekTo >= 0) {
                    player.seekTo(seekTo);
                    seekTo = -1;
                    ui.removeCallbacks(hideSeek);
                    ui.postDelayed(hideSeek, 1200);
                }
                return true;
            }
        }
        return view.dispatchKeyEvent(e) || super.dispatchKeyEvent(e);
    }

    /** the pages send the channels (or fetch them when the guide opens: "guide": true) */
    private boolean hasGuide() { return channels.length() > 1 || cfg.optBoolean("guide"); }

    private static boolean digit(int k) { return k >= KeyEvent.KEYCODE_0 && k <= KeyEvent.KEYCODE_9; }

    /* a channel number from the remote's digits: goes 1.5 s after the last one; 0 alone = the one before */
    private void typeDigit(int k) {
        if (digits.length() >= 5) return;
        digits += (char) ('0' + (k - KeyEvent.KEYCODE_0));
        osd.setText("Channel " + digits + "_");
        osd.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideOsd);
        ui.removeCallbacks(numberDone);
        ui.postDelayed(numberDone, 1500);
    }

    private final Runnable numberDone = () -> {
        String d = digits;
        digits = "";
        ui.postDelayed(PlayerActivity.this.hideOsd, 1200);
        if (d.isEmpty()) return;
        try {
            if (d.equals("0")) { osd.setText("⟲ The channel before"); emit("last", null); }
            else { osd.setText("Channel " + d); emit("number", new JSONObject().put("num", d).toString()); }
        } catch (Exception ignored) { }
    };

    private final Runnable hideSeek = () -> seekBox.setVisibility(View.GONE);

    private void showSeek(int dir, long dur) {
        ui.removeCallbacks(hideSeek);
        long cur = player.getCurrentPosition();
        long diff = (seekTo - cur) / 1000;
        seekText.setText((dir > 0 ? "⏩  " : "⏪  ") + clock(seekTo) + (dur > 0 && dur != C.TIME_UNSET ? " / " + clock(dur) : "") + "   (" + (diff >= 0 ? "+" : "−") + clock(Math.abs(diff) * 1000) + ")");
        seekBar.setProgress(dur > 0 && dur != C.TIME_UNSET ? (int) (seekTo * 1000 / dur) : 0);
        seekBox.setVisibility(View.VISIBLE);
        view.hideController();
    }

    private static String clock(long ms) {
        long s = ms / 1000, h = s / 3600, m = (s % 3600) / 60;
        return h > 0 ? String.format(Locale.US, "%d:%02d:%02d", h, m, s % 60) : String.format(Locale.US, "%d:%02d", m, s % 60);
    }

    /* ---------------- the channel guide ---------------- */
    private void showGuide() {
        hideMenu();
        view.hideController();
        guideBox.setVisibility(View.VISIBLE);
        guide.notifyDataSetChanged();
        guideList.requestFocus();
        if (chIndex >= 0 && chIndex < channels.length()) guideList.setSelection(chIndex);
        emit("guide", null);
        askEpg(Math.max(0, chIndex - 4), 10);
    }

    private void hideGuide() { guideBox.setVisibility(View.GONE); }

    private void tune(int pos) {
        hideGuide();
        if (pos == chIndex) return;
        try { emit("tune", new JSONObject().put("index", pos).toString()); } catch (Exception ignored) { }
    }

    /* what's on, for the rows in view (player-tv.js asks the provider) */
    private void askEpg(int first, int count) {
        if (guideBox.getVisibility() != View.VISIBLE) return;
        JSONArray ids = new JSONArray();
        for (int i = first; i < Math.min(channels.length(), first + count + 2); i++) {
            String id = channels.optJSONObject(i) == null ? "" : channels.optJSONObject(i).optString("id");
            if (!id.isEmpty() && asked.add(id)) ids.put(id);
        }
        if (ids.length() == 0) return;
        try { emit("epgNeed", new JSONObject().put("ids", ids).toString()); } catch (Exception ignored) { }
    }

    private class GuideAdapter extends BaseAdapter {
        @Override public int getCount() { return channels.length(); }
        @Override public Object getItem(int i) { return channels.optJSONObject(i); }
        @Override public long getItemId(int i) { return i; }
        @Override public View getView(int i, View v, ViewGroup parent) {
            LinearLayout row = (LinearLayout) v;
            if (row == null) {
                row = new LinearLayout(PlayerActivity.this);
                row.setPadding(dp(10), dp(9), dp(10), dp(9));
                row.setGravity(Gravity.CENTER_VERTICAL);
                TextView num = text(15, 0xFF8B93A1, false);
                num.setGravity(Gravity.END);
                row.addView(num, new LinearLayout.LayoutParams(dp(46), -2));
                LinearLayout col = new LinearLayout(PlayerActivity.this);
                col.setOrientation(LinearLayout.VERTICAL);
                col.setPadding(dp(14), 0, 0, 0);
                TextView name = text(17, Color.WHITE, true);
                name.setSingleLine(true);
                name.setEllipsize(android.text.TextUtils.TruncateAt.END);
                TextView now = text(13, 0xFFC9CED6, false);
                now.setSingleLine(true);
                now.setEllipsize(android.text.TextUtils.TruncateAt.END);
                TextView next = text(12, 0xFF8B93A1, false);
                next.setSingleLine(true);
                next.setEllipsize(android.text.TextUtils.TruncateAt.END);
                col.addView(name);
                col.addView(now);
                col.addView(next);
                row.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
            }
            JSONObject c = channels.optJSONObject(i);
            if (c == null) c = new JSONObject();
            LinearLayout col = (LinearLayout) row.getChildAt(1);
            ((TextView) row.getChildAt(0)).setText(c.optString("num", ""));
            TextView name = (TextView) col.getChildAt(0);
            name.setText((i == chIndex ? "▶  " : "") + c.optString("name"));
            name.setTextColor(i == chIndex ? ACCENT : Color.WHITE);
            String[] on = onNow.get(c.optString("id"));
            TextView now = (TextView) col.getChildAt(1), next = (TextView) col.getChildAt(2);
            now.setText(on == null ? "" : on[0]);
            now.setVisibility(on == null || on[0].isEmpty() ? View.GONE : View.VISIBLE);
            next.setText(on == null ? "" : on[1]);
            next.setVisibility(on == null || on[1].isEmpty() ? View.GONE : View.VISIBLE);
            return row;
        }
    }

    /* ---------------- ☰ : the side panel ---------------- */
    private interface Rows { void fill(); }

    private void menu() {
        hideGuide();
        view.hideController();
        menuUp.clear();
        avsyncShown = offsetUs;
        openPage(this::mainPage);
        menuBox.setVisibility(View.VISIBLE);
    }

    private void openPage(Runnable page) {
        menuUp.add(page);
        page.run();
    }

    private void menuBack() {
        if (menuUp.size() > 1) { menuUp.remove(menuUp.size() - 1); menuUp.get(menuUp.size() - 1).run(); return; }
        hideMenu();
    }

    private void hideMenu() {
        if (menuBox.getVisibility() != View.VISIBLE) return;
        menuBox.setVisibility(View.GONE);
        menuUp.clear();
        if (offsetUs != avsyncShown) {   // audio sync changed in the panel: saved for this sound output
            avsyncShown = offsetUs;
            try { emit("avsync", new JSONObject().put("ms", offsetUs / 1000).toString()); } catch (Exception ignored) { }
        }
    }

    private void page(String title) {
        menuTitle.setText(title);
        menuRows.removeAllViews();
        menuScroll.scrollTo(0, 0);
    }

    /** a row: label on the left, its value on the right; the first row (or "focus") gets the focus */
    private View row(String label, String value, boolean focus, Runnable run) {
        LinearLayout r = new LinearLayout(this);
        r.setFocusable(true);
        r.setClickable(true);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(dp(14), dp(13), dp(14), dp(13));
        r.setBackground(rowBg(false));
        TextView l = text(16, Color.WHITE, false);
        r.addView(l, new LinearLayout.LayoutParams(0, -2, 1));
        l.setText(label);
        if (value != null) {
            TextView v = text(15, 0xFFA3A9B5, false);
            v.setText(value);
            r.addView(v);
        }
        r.setOnClickListener(x -> run.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.setMargins(0, dp(2), 0, dp(2));
        menuRows.addView(r, lp);
        if (focus || menuRows.getChildCount() == 1) r.requestFocus();
        return r;
    }

    private void note(String t) {
        TextView n = text(13, 0xFF8B93A1, false);
        n.setText(t);
        n.setPadding(dp(14), dp(10), dp(14), dp(4));
        menuRows.addView(n);
    }

    private void mainPage() {
        page(cfg.optString("title", "Seal IPTV"));
        boolean live = cfg.optBoolean("live");
        if (live && hasGuide()) row("Channel guide", null, false, () -> { hideMenu(); showGuide(); });
        row("Audio", trackName(C.TRACK_TYPE_AUDIO, "Default"), false, () -> openPage(() -> trackPage(C.TRACK_TYPE_AUDIO, "Audio")));
        row("Subtitles", trackName(C.TRACK_TYPE_TEXT, "Off"), false, () -> openPage(() -> trackPage(C.TRACK_TYPE_TEXT, "Subtitles")));
        if (!live) row("Speed", speedName(player == null ? 1f : player.getPlaybackParameters().speed), false, () -> openPage(this::speedPage));
        row("Picture size", resizeName(view.getResizeMode()), false, () -> openPage(this::resizePage));
        row("Audio sync", sign(offsetUs / 1000) + " ms", false, () -> openPage(this::avsyncPage));
        if (cfg.optBoolean("hasNext")) row("Next episode", null, false, () -> { hideMenu(); goNext(); });
        row("Open in another app", null, false, () -> { hideMenu(); emit("external", null); finishPlayer(false); });
    }

    /* audio / subtitle tracks, as the stream has them */
    private static class Track { Tracks.Group group; int index; String name; boolean on; }

    private List<Track> tracksOf(int type) {
        List<Track> out = new ArrayList<>();
        if (player == null) return out;
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != type) continue;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSupported(i)) continue;
                Track t = new Track();
                t.group = g; t.index = i; t.on = g.isTrackSelected(i); t.name = describe(g.getTrackFormat(i), out.size() + 1);
                out.add(t);
            }
        }
        return out;
    }

    private static String describe(Format f, int n) {
        List<String> bits = new ArrayList<>();
        if (f.label != null && !f.label.isEmpty()) bits.add(f.label);
        else if (f.language != null && !f.language.isEmpty() && !f.language.equals("und")) bits.add(new Locale(f.language).getDisplayLanguage(Locale.ENGLISH));
        String m = f.sampleMimeType == null ? "" : f.sampleMimeType;
        String codec = m.contains("eac3") ? "E-AC-3" : m.contains("ac3") ? "AC-3" : m.contains("dts") ? "DTS" : m.contains("mp4a") || m.contains("aac") ? "AAC" : m.contains("mpeg") ? "MP3" : m.contains("opus") ? "Opus" : "";
        if (!codec.isEmpty()) bits.add(codec);
        if (f.channelCount > 0) bits.add(f.channelCount == 1 ? "mono" : f.channelCount == 2 ? "stereo" : f.channelCount == 6 ? "5.1" : f.channelCount == 8 ? "7.1" : f.channelCount + " ch");
        return bits.isEmpty() ? "Track " + n : String.join(" · ", bits);
    }

    private String trackName(int type, String none) {
        if (type == C.TRACK_TYPE_TEXT && player != null && player.getTrackSelectionParameters().disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) return "Off";
        for (Track t : tracksOf(type)) if (t.on) return t.name;
        return none;
    }

    private void trackPage(int type, String title) {
        page(title);
        List<Track> list = tracksOf(type);
        boolean text = type == C.TRACK_TYPE_TEXT;
        boolean off = text && (player == null || player.getTrackSelectionParameters().disabledTrackTypes.contains(C.TRACK_TYPE_TEXT) || list.stream().noneMatch(t -> t.on));
        if (text) row((off ? "✓  " : "     ") + "Off", null, off, () -> {
            if (player != null) player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
            menuBack();
        });
        for (Track t : list) row((t.on && !off ? "✓  " : "     ") + t.name, null, t.on && !off, () -> {
            if (player != null) player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(type, false)
                    .setOverrideForType(new TrackSelectionOverride(t.group.getMediaTrackGroup(), t.index)).build());
            menuBack();
        });
        if (list.isEmpty()) note(text ? "This stream has no subtitles." : "This stream has one sound track.");
    }

    private static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};
    private static String speedName(float s) { return s == 1f ? "Normal" : (s == (int) s ? String.valueOf((int) s) : String.valueOf(s)) + "×"; }

    private void speedPage() {
        page("Speed");
        float cur = player == null ? 1f : player.getPlaybackParameters().speed;
        for (float s : SPEEDS) row((Math.abs(s - cur) < .01 ? "✓  " : "     ") + speedName(s), null, Math.abs(s - cur) < .01, () -> {
            if (player != null) player.setPlaybackSpeed(s);
            menuBack();
        });
    }

    private static final int[] RESIZE = {AspectRatioFrameLayout.RESIZE_MODE_FIT, AspectRatioFrameLayout.RESIZE_MODE_ZOOM, AspectRatioFrameLayout.RESIZE_MODE_FILL};
    private static String resizeName(int m) { return m == AspectRatioFrameLayout.RESIZE_MODE_ZOOM ? "Zoom (fills, cuts the edges)" : m == AspectRatioFrameLayout.RESIZE_MODE_FILL ? "Stretch (fills, out of shape)" : "Fit (all of the picture)"; }

    private void resizePage() {
        page("Picture size");
        int cur = view.getResizeMode();
        for (int m : RESIZE) row((m == cur ? "✓  " : "     ") + resizeName(m), null, m == cur, () -> {
            view.setResizeMode(m);
            getSharedPreferences("player", MODE_PRIVATE).edit().putInt("resize", m).apply();   // kept for next time
            menuBack();
        });
        note("Kept for everything you watch on this TV.");
    }

    private void avsyncPage() {
        page("Audio sync");
        long ms = offsetUs / 1000;
        TextView value = text(28, Color.WHITE, true);
        value.setGravity(Gravity.CENTER);
        value.setText(sign(ms) + " ms");
        value.setPadding(0, dp(4), 0, dp(2));
        menuRows.addView(value);
        TextView what = text(14, 0xFFA3A9B5, false);
        what.setGravity(Gravity.CENTER);
        what.setText(ms > 0 ? "Picture waits " + ms + " ms for the sound" : ms < 0 ? "Sound waits " + (-ms) + " ms for the picture" : "No delay");
        menuRows.addView(what);
        int[] steps = {10, 50, -10, -50};
        for (int i = 0; i < steps.length; i++) {
            int step = steps[i];
            row((step > 0 ? "+" : "−") + Math.abs(step) + " ms" + (step > 0 ? "   picture later" : "   sound later"), null, i == 0, () -> {
                offsetUs = Math.max(-500, Math.min(1000, offsetUs / 1000 + step)) * 1000L;
                avsyncPage();
                focusRowWith((step > 0 ? "+" : "−") + Math.abs(step) + " ms");
            });
        }
        row("Back to 0", null, false, () -> { offsetUs = 0; avsyncPage(); focusRowWith("Back to 0"); });
        if (!cfg.optString("device", "").isEmpty()) note("For " + cfg.optString("device") + ". Kept for that sound output.");
    }

    private void focusRowWith(String start) {
        for (int i = 0; i < menuRows.getChildCount(); i++) {
            View c = menuRows.getChildAt(i);
            if (c instanceof LinearLayout && ((LinearLayout) c).getChildCount() > 0 && ((LinearLayout) c).getChildAt(0) instanceof TextView
                    && ((TextView) ((LinearLayout) c).getChildAt(0)).getText().toString().startsWith(start)) { c.requestFocus(); return; }
        }
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
    /** a list row: lit up, with a green ring, when it has the focus */
    private android.graphics.drawable.StateListDrawable rowBg(boolean selector) {
        GradientDrawable on = round(0xFF272C36, 10);
        on.setStroke(dp(3), ACCENT);
        android.graphics.drawable.StateListDrawable bg = new android.graphics.drawable.StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, on);
        if (selector) bg.addState(new int[]{android.R.attr.state_selected}, on);
        if (selector) bg.addState(new int[]{android.R.attr.state_pressed}, on);
        bg.addState(new int[]{}, new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        return bg;
    }

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
