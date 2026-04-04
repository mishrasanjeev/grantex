from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="zoom",
    description="Zoom Video Communications API",
    tools={
        "create_meeting": Permission.WRITE,
        "get_recording": Permission.READ,
        "cancel_meeting": Permission.DELETE,
        "get_attendance_report": Permission.READ,
        "add_panelist": Permission.WRITE,
        "get_transcript": Permission.READ,
    },
)
