from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="twilio",
    description="Twilio Communications API",
    tools={
        "send_sms": Permission.WRITE,
        "make_call": Permission.WRITE,
        "send_whatsapp": Permission.WRITE,
        "get_recordings": Permission.READ,
        "get_message_status": Permission.READ,
    },
)
