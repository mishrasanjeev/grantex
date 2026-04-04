from grantex.manifest import ToolManifest, Permission

manifest = ToolManifest(
    connector="mca_portal",
    description="MCA (Ministry of Corporate Affairs) Portal API",
    tools={
        "file_annual_return": Permission.WRITE,
        "complete_director_kyc": Permission.WRITE,
        "fetch_company_master_data": Permission.READ,
        "file_charge_satisfaction": Permission.WRITE,
    },
)
