"""建物・階・トイレなど、ツール間で表記を揃えたい表示名。"""

TOILET_ROOMS = {"M_Toilet", "F_Toilet", "C_Toilet"}


def building_label(building: int) -> str:
    """0 は屋外、それ以外は「N号館」"""
    return "屋外" if int(building) == 0 else f"{int(building)}号館"


def floor_label(floor: int) -> str:
    """0 は屋外、それ以外は「NF」"""
    return "屋外" if int(floor) == 0 else f"{int(floor)}F"
