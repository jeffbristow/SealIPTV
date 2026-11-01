/* =====================================================================
 * Seal IPTV for Ubuntu Touch — qml/Player.qml   (the native player)
 * ---------------------------------------------------------------------
 * What PlayerActivity.java is on Android, with QtMultimedia (GStreamer:
 * HLS, MPEG-TS, MP4; hardware decoding through hybris). Started by
 * player-tv.js (load(json): { url, live, start ms, title, subtitle,
 * canZap, next, hasNext, channels [{ id, name, num }], index }) and told
 * commands (close, subtitle, osd, channels, epg). Sends back the same
 * events: progress / ended / next / zap / error / closed, and for the
 * channel list guide / epgNeed { ids } / tune { index }.
 * Touch: tap = controls; ← Back, ☰ Channels, ▲ ▼ the channel before / after;
 * double-tap left / right = back / forward 10 s, the middle = pause.
 * ===================================================================== */
import QtQuick 2.12
import QtMultimedia 5.12
import QtSystemInfo 5.0
import Lomiri.Components 1.3

Item {
    id: p
    signal event(var ev)

    property var cfg: ({})
    property var channels: []
    property int chIndex: -1
    property var onNow: ({})          // channel id -> [now, next]
    property var asked: ({})
    property bool live: !!cfg.live
    property bool started: false
    property bool closing: false
    property bool handedOver: false
    property int nextLeft: 0
    readonly property color accent: "#3ccf91"

    // the screen stays on while something plays
    ScreenSaver { screenSaverEnabled: !(p.visible && media.playbackState === MediaPlayer.PlayingState) }

    Rectangle { anchors.fill: parent; color: "black" }

    MediaPlayer {
        id: media
        autoPlay: true
        onStatusChanged: {
            if ((status === MediaPlayer.Loaded || status === MediaPlayer.Buffered) && !p.started) {
                p.started = true
                if (!p.live && p.cfg.start > 0) media.seek(p.cfg.start)
            }
            if (status === MediaPlayer.EndOfMedia) ended()
        }
        onError: failed(errorString)
        onPlaybackStateChanged: console.log("SealPlayer: state " + playbackState + ", status " + status)
    }
    // The media service doesn't always say when it can't play (a sound output it can't open: it just
    // resets itself). Nothing moving 8 s after starting = it can't: the page plays it instead.
    Timer {
        id: watchdog
        interval: 8000
        onTriggered: {
            console.log("SealPlayer: watchdog, position " + media.position + ", status " + media.status)
            if (!p.closing && p.visible && media.position <= 0) p.failed("the phone's media service didn't start it")
        }
    }
    VideoOutput { id: video; anchors.fill: parent; source: media; fillMode: VideoOutput.PreserveAspectFit }

    function send(type, extra) {
        var ev = extra || {}
        ev.type = type
        ev.pos = Math.max(0, media.position)
        ev.dur = media.duration > 0 ? media.duration : 0
        p.event(ev)
    }

    function clock(ms) {
        var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
        return (h > 0 ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (x < 10 ? "0" : "") + x
    }

    /* ---------------- playing ---------------- */
    function load(js) {
        var c = {}
        try { c = JSON.parse(js) } catch (e) { }
        cfg = c
        closing = false
        handedOver = false
        started = false
        errorBox.visible = false
        nextBox.visible = false
        nextTimer.stop()
        if (!c.live) channels = []
        else if (c.channels) channels = c.channels   // else: the same list as before (a zap in it)
        chIndex = c.index !== undefined ? c.index : -1
        guide.visible = false
        visible = true
        media.stop()
        media.source = c.url
        media.play()
        showControls()
        progressTimer.restart()
        watchdog.restart()
    }

    function command(js) {
        var c = {}
        try { c = JSON.parse(js) } catch (e) { return }
        if (c.cmd === "close") close(true)
        else if (c.cmd === "subtitle") subText.text = c.text
        else if (c.cmd === "osd") osd.show(c.text)
        else if (c.cmd === "channels") {
            channels = c.channels || []
            if (c.index !== undefined) chIndex = c.index
            if (channels.length > 1) { var x = cfg; x.canZap = true; cfg = x }
            if (guide.visible && chIndex >= 0) list.positionViewAtIndex(chIndex, ListView.Center)
        } else if (c.cmd === "epg") {
            var o = onNow
            for (var i = 0; i < (c.items || []).length; i++) o[c.items[i].id] = [c.items[i].now, c.items[i].next]
            onNow = o
            list.forceLayout()
            onNowChanged()
        }
    }

    function close(tell) {
        if (closing) return
        closing = true
        if (tell) send("closed")
        watchdog.stop()
        progressTimer.stop()
        nextTimer.stop()
        media.stop()
        media.source = ""
        visible = false
    }

    function ended() {
        send("ended")
        if (!cfg.next) return            // player-tv.js closes us
        nextLeft = 10
        nextBox.visible = true
        nextTimer.start()
    }

    function failed(why) {
        if (closing) return
        // the media service couldn't play it (on some phones it can't open the sound output at all):
        // the page plays it instead (utplayer.js), from where this got to
        if (!p.handedOver) {
            p.handedOver = true
            send("fallback", { message: why || "" })
            closing = true
            progressTimer.stop()
            media.stop()
            media.source = ""
            visible = false
            return
        }
        errorText.text = "This can't be played here" + (why ? " (" + why + ")" : "") + ".\nIt may be offline, or the VPN may be off."
        errorBox.visible = true
        send("error", { message: why || "" })
    }

    function zap(dir) { osd.show(dir < 0 ? "▲  Previous channel" : "▼  Next channel"); send("zap", { dir: dir }) }

    function skip(dir) {
        var to = Math.max(0, media.position + dir * 10000)
        if (media.duration > 0) to = Math.min(media.duration - 1000, to)
        media.seek(to)
        osd.show((dir < 0 ? "⏪  −10 s   " : "⏩  +10 s   ") + clock(to))
    }

    Timer { id: progressTimer; interval: 5000; repeat: true; onTriggered: if (media.playbackState === MediaPlayer.PlayingState) send("progress") }
    Timer {
        id: nextTimer; interval: 1000; repeat: true
        onTriggered: { if (--p.nextLeft <= 0) { stop(); nextBox.visible = false; send("next") } }
    }

    /* ---------------- touch ---------------- */
    function showControls() { controls.opacity = 1; hideTimer.restart() }
    Timer { id: hideTimer; interval: 4000; onTriggered: if (media.playbackState === MediaPlayer.PlayingState) controls.opacity = 0 }

    MouseArea {
        anchors.fill: parent
        property real lastTap: 0
        property real lastX: 0
        Timer { id: singleTap; interval: 280; onTriggered: { if (guide.visible) guide.visible = false; else if (controls.opacity > 0) controls.opacity = 0; else p.showControls() } }
        onClicked: {
            var now = Date.now()
            if (now - lastTap < 280 && Math.abs(mouse.x - lastX) < 80) {
                singleTap.stop()
                lastTap = 0
                if (guide.visible) return
                var f = mouse.x / width
                if ((f > 0.35 && f < 0.65) || p.live) {
                    if (media.playbackState === MediaPlayer.PlayingState) media.pause(); else media.play()
                    osd.show(media.playbackState === MediaPlayer.PlayingState ? "▶  Playing" : "❚❚  Paused")
                } else skip(f < 0.5 ? -1 : 1)
                return
            }
            lastTap = now
            lastX = mouse.x
            singleTap.restart()
        }
    }

    Item {
        id: controls
        anchors.fill: parent
        Behavior on opacity { NumberAnimation { duration: 180 } }
        visible: opacity > 0

        // top: ← | title | Channels ▲ ▼
        Rectangle {
            anchors { left: parent.left; right: parent.right; top: parent.top }
            height: topRow.height + units.gu(3)
            gradient: Gradient { GradientStop { position: 0; color: "#cc000000" } GradientStop { position: 1; color: "#00000000" } }
            Row {
                id: topRow
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: units.gu(1) }
                spacing: units.gu(0.5)
                Btn { text: "←"; onClicked: p.close(true) }
                Column {
                    width: topRow.width - x - (zapRow.visible || chBtn.visible ? zapRow.width + chBtn.width + units.gu(1) : 0)
                    anchors.verticalCenter: parent.verticalCenter
                    Text { width: parent.width; text: p.cfg.title || ""; color: "white"; font.bold: true; font.pixelSize: units.gu(2.1); elide: Text.ElideRight }
                    Text { id: subText; width: parent.width; text: p.cfg.subtitle || ""; color: "#c9ced6"; font.pixelSize: units.gu(1.6); elide: Text.ElideRight }
                }
                Btn { id: chBtn; text: "☰  Channels"; visible: p.live && (p.channels.length > 1 || !!p.cfg.guide); onClicked: p.openGuide() }
                Row {
                    id: zapRow; spacing: units.gu(0.5); visible: p.live && !!p.cfg.canZap
                    Btn { text: "▲"; onClicked: p.zap(-1) }
                    Btn { text: "▼"; onClicked: p.zap(1) }
                }
            }
        }

        // bottom: play / pause, −10 +10, the time bar
        Rectangle {
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
            height: units.gu(11)
            gradient: Gradient { GradientStop { position: 0; color: "#00000000" } GradientStop { position: 1; color: "#cc000000" } }
            Row {
                id: btns
                anchors { horizontalCenter: parent.horizontalCenter; top: parent.top; topMargin: units.gu(0.5) }
                spacing: units.gu(2)
                Btn { text: "−10"; visible: !p.live; onClicked: { p.skip(-1); p.showControls() } }
                Btn { text: media.playbackState === MediaPlayer.PlayingState ? "❚❚" : "▶"; wide: true; onClicked: { if (media.playbackState === MediaPlayer.PlayingState) media.pause(); else media.play(); p.showControls() } }
                Btn { text: "+10"; visible: !p.live; onClicked: { p.skip(1); p.showControls() } }
            }
            Item {
                visible: !p.live && media.duration > 0
                anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: units.gu(1.5) }
                height: units.gu(3)
                Text { id: tNow; anchors.verticalCenter: parent.verticalCenter; text: p.clock(media.position); color: "white"; font.pixelSize: units.gu(1.5) }
                Text { id: tAll; anchors { right: parent.right; verticalCenter: parent.verticalCenter } text: p.clock(media.duration); color: "#c9ced6"; font.pixelSize: units.gu(1.5) }
                Item {
                    id: bar
                    anchors { left: tNow.right; right: tAll.left; leftMargin: units.gu(1.5); rightMargin: units.gu(1.5); verticalCenter: parent.verticalCenter }
                    height: units.gu(3)
                    property real at: dragArea.pressed ? dragArea.frac : (media.duration > 0 ? media.position / media.duration : 0)
                    Rectangle { anchors.verticalCenter: parent.verticalCenter; width: parent.width; height: units.gu(0.5); radius: height / 2; color: "#55ffffff" }
                    Rectangle { anchors.verticalCenter: parent.verticalCenter; width: parent.width * bar.at; height: units.gu(0.5); radius: height / 2; color: p.accent }
                    Rectangle { x: parent.width * bar.at - width / 2; anchors.verticalCenter: parent.verticalCenter; width: units.gu(2); height: width; radius: width / 2; color: "white" }
                    MouseArea {
                        id: dragArea
                        anchors.fill: parent
                        anchors.margins: -units.gu(1)
                        property real frac: 0
                        onPressed: { frac = Math.max(0, Math.min(1, mouse.x / bar.width)); hideTimer.stop() }
                        onPositionChanged: frac = Math.max(0, Math.min(1, mouse.x / bar.width))
                        onReleased: { media.seek(frac * media.duration); p.showControls() }
                    }
                }
            }
        }
    }

    Rectangle { visible: p.live && controls.opacity > 0; anchors { left: parent.left; bottom: parent.bottom; margins: units.gu(2) }
        width: liveTxt.width + units.gu(1.6); height: liveTxt.height + units.gu(0.6); radius: units.gu(0.5); color: "#ff6464"
        Text { id: liveTxt; anchors.centerIn: parent; text: "LIVE"; color: "white"; font.bold: true; font.pixelSize: units.gu(1.4) } }

    BusyIndicatorDots { anchors.centerIn: parent; visible: media.status === MediaPlayer.Loading || media.status === MediaPlayer.Stalled || (media.status === MediaPlayer.Buffering && media.playbackState === MediaPlayer.PlayingState) }

    // a message in the middle, for a moment
    Rectangle {
        id: osd
        anchors { horizontalCenter: parent.horizontalCenter; top: parent.top; topMargin: units.gu(9) }
        width: osdText.width + units.gu(3); height: osdText.height + units.gu(1.6); radius: units.gu(1); color: "#e6121418"
        opacity: 0
        Behavior on opacity { NumberAnimation { duration: 150 } }
        Text { id: osdText; anchors.centerIn: parent; color: "white"; font.pixelSize: units.gu(1.9) }
        Timer { id: osdTimer; interval: 1600; onTriggered: osd.opacity = 0 }
        function show(t) { osdText.text = t; opacity = 1; osdTimer.restart() }
    }

    // the channel list (live): what's on now and next
    function openGuide() {
        guide.visible = true
        controls.opacity = 0
        if (chIndex >= 0) list.positionViewAtIndex(chIndex, ListView.Center)
        send("guide")
        askEpg()
    }
    function askEpg() {
        if (!guide.visible) return
        var first = Math.max(0, list.indexAt(10, list.contentY + 10)), ids = [], a = asked
        for (var i = first; i < Math.min(channels.length, first + 14); i++) {
            var id = String(channels[i].id)
            if (!a[id]) { a[id] = true; ids.push(id) }
        }
        asked = a
        if (ids.length) send("epgNeed", { ids: ids })
    }
    Rectangle {
        id: guide
        visible: false
        anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
        width: Math.min(parent.width * 0.85, units.gu(50))
        color: "#f2121418"
        MouseArea { anchors.fill: parent }   // taps on the list stay in it
        Text { id: gTitle; x: units.gu(2); y: units.gu(2); text: "Channels"; color: "white"; font.bold: true; font.pixelSize: units.gu(2.2) }
        Text { anchors { left: gTitle.right; leftMargin: units.gu(1.5); baseline: gTitle.baseline } text: "Tap one to watch it"; color: "#8b93a1"; font.pixelSize: units.gu(1.4) }
        ListView {
            id: list
            anchors { left: parent.left; right: parent.right; top: gTitle.bottom; bottom: parent.bottom; topMargin: units.gu(1) }
            clip: true
            model: p.channels.length
            onContentYChanged: epgTimer.restart()
            Timer { id: epgTimer; interval: 250; onTriggered: p.askEpg() }
            delegate: Rectangle {
                width: list.width; height: units.gu(7.5)
                property var ch: p.channels[index] || {}
                property var on: p.onNow[String(ch.id)] || ["", ""]
                color: rowArea.pressed ? "#272c36" : "transparent"
                Text { id: num; x: units.gu(1); width: units.gu(4.5); anchors.verticalCenter: parent.verticalCenter; horizontalAlignment: Text.AlignRight; text: ch.num || ""; color: "#8b93a1"; font.pixelSize: units.gu(1.6) }
                Column {
                    anchors { left: num.right; right: parent.right; leftMargin: units.gu(1.5); rightMargin: units.gu(1); verticalCenter: parent.verticalCenter }
                    Text { width: parent.width; text: (index === p.chIndex ? "▶  " : "") + (ch.name || ""); color: index === p.chIndex ? p.accent : "white"; font.bold: true; font.pixelSize: units.gu(1.9); elide: Text.ElideRight }
                    Text { width: parent.width; visible: !!on[0]; text: on[0]; color: "#c9ced6"; font.pixelSize: units.gu(1.5); elide: Text.ElideRight }
                    Text { width: parent.width; visible: !!on[1]; text: on[1]; color: "#8b93a1"; font.pixelSize: units.gu(1.4); elide: Text.ElideRight }
                }
                MouseArea { id: rowArea; anchors.fill: parent; onClicked: { guide.visible = false; if (index !== p.chIndex) p.send("tune", { index: index }) } }
            }
        }
    }

    // next episode
    Rectangle {
        id: nextBox; visible: false
        anchors { right: parent.right; bottom: parent.bottom; margins: units.gu(3) }
        width: units.gu(36); height: nextCol.height + units.gu(3); radius: units.gu(1.5); color: "#f0181b21"
        Column {
            id: nextCol; anchors { left: parent.left; right: parent.right; top: parent.top; margins: units.gu(1.5) } spacing: units.gu(1)
            Text { width: parent.width; text: "Next episode in " + p.nextLeft + " s\n" + (p.cfg.next || ""); color: "white"; font.pixelSize: units.gu(1.8); wrapMode: Text.Wrap }
            Btn { text: "Play now"; primary: true; onClicked: { nextTimer.stop(); nextBox.visible = false; p.send("next") } }
        }
    }

    // didn't play
    Rectangle {
        id: errorBox; visible: false
        anchors.centerIn: parent
        width: Math.min(parent.width - units.gu(4), units.gu(52)); height: errCol.height + units.gu(3); radius: units.gu(1.5); color: "#f0181b21"
        MouseArea { anchors.fill: parent }
        Column {
            id: errCol; anchors { left: parent.left; right: parent.right; top: parent.top; margins: units.gu(1.5) } spacing: units.gu(1.5)
            Text { id: errorText; width: parent.width; color: "white"; font.pixelSize: units.gu(1.8); wrapMode: Text.Wrap }
            Btn { text: "Close"; primary: true; onClicked: p.close(true) }
        }
    }
}
