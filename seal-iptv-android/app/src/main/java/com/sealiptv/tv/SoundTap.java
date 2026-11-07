/* =====================================================================
 * Seal IPTV for Fire TV — SoundTap.java   (the player's sound -> prints)
 * ---------------------------------------------------------------------
 * Sits in the player's audio output (PlayerActivity's AudioSink) and
 * listens to the sound on its way out — nothing more is streamed. Turns
 * it into AudioPrint numbers (8 a second) for intros.js: where an
 * episode's intro and end credits are (Skip intro / Next episode).
 *
 * Decoded sound (PCM) is read as it is. Dolby (AC-3 / E-AC-3) sent on
 * as it is to the TV / sound bar is decoded a second time here, only
 * for listening (the sound played isn't touched).
 * Called on the player's own thread; out() is called there too.
 * ===================================================================== */
package com.sealiptv.tv;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.util.Log;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

@OptIn(markerClass = UnstableApi.class)
final class SoundTap {
    private static final String TAG = "SealPrint";
    volatile boolean enabled = false;

    private final AudioPrint print;
    private int encoding = C.ENCODING_INVALID, channels = 0, rate = 0;
    private boolean pcm = false;
    private long streamOffsetUs = 0;
    private boolean restart = true;
    private double expect = -1;                  // the media time the next sound should have
    private ByteBuffer lastBuf;
    private long lastPts = Long.MIN_VALUE;
    private float[] mono = new float[8192];
    private String told = "";
    private int resets = 0;

    // Dolby passed through: a decoder of our own, for listening only
    private MediaCodec dec;
    private String decMime;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private boolean decFailed = false;

    SoundTap(AudioPrint.Out out) { print = new AudioPrint(out); }

    /** the sound's format (AudioSink.configure) */
    synchronized void configure(Format f) {
        pcm = MimeTypes.AUDIO_RAW.equals(f.sampleMimeType);
        encoding = pcm ? f.pcmEncoding : C.ENCODING_INVALID;
        channels = f.channelCount;
        rate = f.sampleRate;
        String what = (pcm ? "pcm " + encoding : f.sampleMimeType) + " " + channels + "ch " + rate + "Hz";
        if (!what.equals(told)) { told = what; Log.i(TAG, "sound: " + what); }
        if (!pcm && !(f.sampleMimeType != null && f.sampleMimeType.equals(decMime))) stopDecoder();
        if (!pcm) decMime = f.sampleMimeType;
        restart = true;
    }

    synchronized void setStreamOffsetUs(long us) { streamOffsetUs = us; restart = true; }

    /** a seek, a new stream: the next sound is a new stretch */
    synchronized void restart() {
        restart = true;
        if (dec != null) { try { dec.flush(); } catch (Exception e) { stopDecoder(); } }
    }

    /** a buffer on its way to the speakers (read, never changed) */
    synchronized void take(ByteBuffer b, long ptsUs) {
        if (!enabled || b == null || !b.hasRemaining()) return;
        if (b == lastBuf && ptsUs == lastPts) return;           // offered again (the output was full)
        lastBuf = b; lastPts = ptsUs;
        try {
            if (pcm) pcm(b.duplicate().order(ByteOrder.LITTLE_ENDIAN), ptsUs, encoding, channels, rate);
            else dolby(b.duplicate(), ptsUs);
        } catch (Exception e) {
            Log.w(TAG, "listening stopped: " + e);
            enabled = false;
        }
    }

    private void pcm(ByteBuffer d, long ptsUs, int enc, int ch, int sr) {
        int bytes = enc == C.ENCODING_PCM_16BIT ? 2 : enc == C.ENCODING_PCM_FLOAT ? 4 : 0;
        if (bytes == 0 || ch <= 0 || sr <= 0) return;
        int frames = d.remaining() / (bytes * ch);
        if (frames == 0) return;
        double t = (ptsUs - streamOffsetUs) / 1e6;
        if (restart || expect < 0 || Math.abs(t - expect) > 0.3) {
            if (resets++ < 20) Log.i(TAG, "listening from " + t + " s (pts " + ptsUs + ", offset " + streamOffsetUs + ")");
            print.reset(t); restart = false;
        }
        expect = t + (double) frames / sr;
        if (mono.length < frames) mono = new float[frames];
        for (int i = 0; i < frames; i++) {
            float s = 0;
            for (int c = 0; c < ch; c++) s += bytes == 2 ? d.getShort() / 32768f : d.getFloat();
            mono[i] = s / ch;
        }
        print.push(mono, frames, sr);
    }

    /* ---- Dolby passed through: decoded again, for listening ---- */
    private void dolby(ByteBuffer d, long ptsUs) throws Exception {
        if (decFailed || decMime == null) return;
        if (dec == null) {
            try {
                MediaFormat f = MediaFormat.createAudioFormat(decMime, rate > 0 ? rate : 48000, channels > 0 ? channels : 2);
                dec = MediaCodec.createDecoderByType(decMime);
                dec.configure(f, null, null, 0);
                dec.start();
                Log.i(TAG, "listening through a decoder of our own: " + decMime);
            } catch (Exception e) {
                Log.i(TAG, "can't listen to " + decMime + ": " + e);
                decFailed = true;
                stopDecoder();
                return;
            }
        }
        int in = dec.dequeueInputBuffer(5000);
        if (in >= 0) {
            ByteBuffer ib = dec.getInputBuffer(in);
            int n = Math.min(ib.remaining(), d.remaining());
            ByteBuffer part = d.slice();
            part.limit(n);
            ib.put(part);
            dec.queueInputBuffer(in, 0, n, ptsUs, 0);
        }
        drain();
    }

    private void drain() {
        while (true) {
            int out = dec.dequeueOutputBuffer(info, 0);
            if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
            if (out < 0) return;
            MediaFormat of = dec.getOutputFormat();
            int ch = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT), sr = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int enc = of.containsKey(MediaFormat.KEY_PCM_ENCODING) ? of.getInteger(MediaFormat.KEY_PCM_ENCODING) : android.media.AudioFormat.ENCODING_PCM_16BIT;
            ByteBuffer ob = dec.getOutputBuffer(out);
            if (ob != null && info.size > 0) {
                ob.position(info.offset);
                ob.limit(info.offset + info.size);
                pcm(ob.slice().order(ByteOrder.LITTLE_ENDIAN), info.presentationTimeUs, enc == android.media.AudioFormat.ENCODING_PCM_FLOAT ? C.ENCODING_PCM_FLOAT : C.ENCODING_PCM_16BIT, ch, sr);
            }
            dec.releaseOutputBuffer(out, false);
        }
    }

    private void stopDecoder() {
        if (dec != null) { try { dec.stop(); } catch (Exception ignored) { } try { dec.release(); } catch (Exception ignored) { } }
        dec = null;
    }

    synchronized void flushPrints() { print.flush(); }

    synchronized void release() { enabled = false; stopDecoder(); }
}
