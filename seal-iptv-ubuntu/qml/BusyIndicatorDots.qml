/* Seal IPTV for Ubuntu Touch — qml/BusyIndicatorDots.qml: three dots while the stream loads */
import QtQuick 2.12
import Lomiri.Components 1.3

Row {
    spacing: units.gu(1)
    Repeater {
        model: 3
        Rectangle {
            width: units.gu(1.4); height: width; radius: width / 2; color: "#3ccf91"
            SequentialAnimation on opacity {
                running: parent.visible; loops: Animation.Infinite
                PauseAnimation { duration: index * 160 }
                NumberAnimation { from: 0.25; to: 1; duration: 320 }
                NumberAnimation { from: 1; to: 0.25; duration: 320 }
                PauseAnimation { duration: (2 - index) * 160 }
            }
        }
    }
}
