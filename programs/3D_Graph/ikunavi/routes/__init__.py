"""APIのエンドポイント定義。機能ごとにBlueprintを分けている"""
from . import events, facilities, images, navigation, rooms, viewer

BLUEPRINTS = (
    viewer.bp,
    rooms.bp,
    events.bp,
    navigation.bp,
    facilities.bp,
    images.bp,
)
