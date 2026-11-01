/* =====================================================================
 * Seal IPTV for Ubuntu Touch — qml/Main.qml
 * ---------------------------------------------------------------------
 * The app: the shared phone pages (www/ut.html) in a full-window web view,
 * served by backend/backend.py (started here through pyotherside), and
 * the native player (Player.qml) on top while something plays.
 *   backend -> here:  play / playerCommand (player-tv.js), external, reload, quit
 *   here -> backend:  player events (progress, ended, closed …), app events (resume / pause)
 * ===================================================================== */
import QtQuick 2.12
import QtQuick.Window 2.12
import Lomiri.Components 1.3
import QtWebEngine 1.10
import io.thp.pyotherside 1.4

MainView {
    id: root
    applicationName: "seal-iptv.jeffbristow"
    anchorToKeyboard: true
    backgroundColor: "#121418"
    width: units.gu(45)
    height: units.gu(80)

    WebEngineView {
        id: web
        anchors.fill: parent
        visible: !player.visible
        backgroundColor: "#121418"
        // the pages at the phone's own scale (1 grid unit = 8 px at scale 1)
        zoomFactor: units.gu(1) / 8
        settings.javascriptCanOpenWindows: false
        settings.localContentCanAccessRemoteUrls: false
        settings.playbackRequiresUserGesture: false
        settings.focusOnNavigationEnabled: true
        profile: WebEngineProfile {
            offTheRecord: false
            storageName: "seal-iptv"
            httpCacheType: WebEngineProfile.MemoryHttpCache
            persistentCookiesPolicy: WebEngineProfile.NoPersistentCookies
        }
        // never leave the app's own pages; links to the web open in the browser
        onNavigationRequested: {
            var u = String(request.url)
            if (u.indexOf("http://127.0.0.1:") === 0) return
            request.action = WebEngineNavigationRequest.IgnoreRequest
            if (u.indexOf("https://") === 0) Qt.openUrlExternally(u)
        }
        onJavaScriptConsoleMessage: {
            if (level === WebEngineView.ErrorMessageLevel || String(message).indexOf("[seal]") === 0)
                console.log("SealWeb: " + message + (level === WebEngineView.ErrorMessageLevel ? " (" + sourceID + ":" + lineNumber + ")" : ""))
        }
        onRenderProcessTerminated: { console.log("SealWeb: the page's process ended, starting again"); reloadTimer.start() }
        Timer { id: reloadTimer; interval: 500; onTriggered: web.reload() }
    }

    Player {
        id: player
        anchors.fill: parent
        visible: false
        onEvent: py.call("backend.player_event", [JSON.stringify(ev)])
    }

    Python {
        id: py
        Component.onCompleted: {
            addImportPath(Qt.resolvedUrl("../backend"))
            setHandler("play", function (js) { player.load(js) })
            setHandler("playerCommand", function (js) { player.command(js) })
            setHandler("external", function (url) { Qt.openUrlExternally(url) })
            setHandler("reload", function () { web.reload() })
            setHandler("quit", function () { Qt.quit() })
            importModule("backend", function () {
                call("backend.start", [], function (url) { web.url = url })
            })
        }
        onError: console.log("SealPy: " + traceback)
    }

    // the app sent to the background / back: the page saves resume points, checks the VPN again
    Connections {
        target: Qt.application
        onStateChanged: py.call("backend.app_event", [Qt.application.state === Qt.ApplicationActive ? "resume" : "pause", "{}"])
    }

}
