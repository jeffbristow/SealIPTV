/* =====================================================================
 * Seal IPTV for Fire TV — AudioPrint.java   (audio fingerprints)
 * ---------------------------------------------------------------------
 * The same as seal-iptv/src/renderer/audioprint.js, for the sound the
 * player plays: 8 numbers a second, compared by intros.js to find a
 * series' intro and end credits (Skip intro / Next episode).
 * MUST give the same numbers as audioprint.js: test/intros-test.js
 * compiles this file and checks.
 * ===================================================================== */
package com.sealiptv.tv;

final class AudioPrint {
    interface Out { void frames(int first, int[] h, int n); }

    static final int RATE = 16000, WIN = 4096, HOP = 2000, FPS = RATE / HOP;
    static final int[] EDGES = {64, 69, 74, 79, 85, 91, 97, 104, 112, 120, 129, 138, 148, 159, 170, 182, 195, 210, 225, 241, 258, 277, 297, 319, 342, 366, 393, 421, 452, 484, 519, 557, 597, 640};
    static final int BANDS = EDGES.length - 1;
    static final double QUIET = 1e-5;

    private static final double[] HANN = new double[WIN], COS = new double[WIN / 2], SIN = new double[WIN / 2];
    private static final int[] REV = new int[WIN];
    static {
        int bits = Integer.numberOfTrailingZeros(WIN);
        for (int i = 0; i < WIN; i++) {
            HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
            int r = 0;
            for (int b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
            REV[i] = r;
        }
        for (int i = 0; i < WIN / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / WIN); SIN[i] = -Math.sin((2 * Math.PI * i) / WIN); }
    }

    private final Out out;
    private double step = 0, edge = 0, sum = 0;
    private long seen = 0;
    private int cnt = 0, have = 0;
    private float[] buf = new float[WIN * 4];
    private double startTime = 0;
    private long used = 0;
    private boolean prev = false, prevQuiet = true;
    private final double[] re = new double[WIN], im = new double[WIN];
    private double[] cur = new double[BANDS], last = new double[BANDS];
    private final int[] pending = new int[16];
    private int pendingFirst = -1, pendingN = 0;

    AudioPrint(Out out) { this.out = out; }

    /** a new stretch of sound starts at this media time (s): playing from a point, a seek */
    void reset(double mediaTime) {
        flush();
        step = 0; edge = 0; sum = 0; seen = 0; cnt = 0; have = 0; used = 0;
        startTime = Math.max(0, mediaTime);
        prev = false; prevQuiet = true;
    }

    /** mono samples (n of them) at rate, following on from what came before */
    void push(float[] mono, int n, int rate) {
        if (step == 0) { step = (double) rate / RATE; edge = step; }
        for (int i = 0; i < n; i++) {
            sum += mono[i]; cnt++; seen++;
            if (seen >= edge) {
                if (have == buf.length) { float[] b = new float[buf.length * 2]; System.arraycopy(buf, 0, b, 0, have); buf = b; }
                buf[have++] = (float) (sum / cnt);
                sum = 0; cnt = 0; edge += step;
            }
        }
        frames();
    }

    void flush() {
        if (pendingN > 0) out.frames(pendingFirst, pending, pendingN);
        pendingFirst = -1; pendingN = 0;
    }

    private void emit(int index, int h) {
        if (pendingFirst >= 0 && index != pendingFirst + pendingN) flush();
        if (pendingFirst < 0) pendingFirst = index;
        pending[pendingN++] = h;
        if (pendingN >= 16) flush();
    }

    private void frames() {
        while (have >= WIN) {
            boolean quiet = bands() < QUIET;
            int index = (int) Math.floor((startTime + (double) used / RATE) * FPS + 0.5);
            if (prev) {
                int h = 0;
                if (!quiet && !prevQuiet) {
                    for (int m = 0; m < BANDS - 1; m++) {
                        if ((cur[m] - cur[m + 1]) - (last[m] - last[m + 1]) > 0) h |= 1 << m;
                    }
                    if (h == 0) h = 1;
                }
                emit(index, h);
            }
            double[] t = last; last = cur; cur = t;
            prev = true; prevQuiet = quiet;
            System.arraycopy(buf, HOP, buf, 0, have - HOP);
            have -= HOP;
            used += HOP;
        }
    }

    /** the energy in each band of buf[0..WIN); returns the mean square */
    private double bands() {
        double sq = 0;
        for (int i = 0; i < WIN; i++) { double x = buf[i]; sq += x * x; re[REV[i]] = x * HANN[i]; im[REV[i]] = 0; }
        for (int size = 2; size <= WIN; size <<= 1) {
            int half = size >> 1, st = WIN / size;
            for (int s = 0; s < WIN; s += size) {
                for (int k = 0; k < half; k++) {
                    double c = COS[k * st], n = SIN[k * st];
                    int a = s + k, b = a + half;
                    double tr = re[b] * c - im[b] * n, ti = re[b] * n + im[b] * c;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                }
            }
        }
        for (int m = 0; m < BANDS; m++) {
            double e = 0;
            for (int k = EDGES[m]; k < EDGES[m + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
            cur[m] = e;
        }
        return sq / WIN;
    }
}
