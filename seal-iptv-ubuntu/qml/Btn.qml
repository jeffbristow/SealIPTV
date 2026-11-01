/* Seal IPTV for Ubuntu Touch — qml/Btn.qml: a round-cornered button for the player, big enough for a thumb */
import QtQuick 2.12
import Lomiri.Components 1.3

Rectangle {
    id: b
    property alias text: label.text
    property bool primary: false
    property bool wide: false
    signal clicked()
    height: units.gu(6)
    width: Math.max(height * (wide ? 1.3 : 1), label.implicitWidth + units.gu(3))
    radius: height / 2
    color: area.pressed ? (primary ? "#4ee0a2" : "#663ccf91") : (primary ? "#3ccf91" : "#44000000")
    Text { id: label; anchors.centerIn: parent; color: b.primary ? "#062418" : "white"; font.bold: true; font.pixelSize: units.gu(2.1) }
    MouseArea { id: area; anchors.fill: parent; onClicked: b.clicked() }
}
