package resources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource              = &ssoConfigResource{}
	_ resource.ResourceWithConfigure = &ssoConfigResource{}
)

// ssoConfigResourceModel maps the resource schema data to a Go type.
type ssoConfigResourceModel struct {
	ID           types.String `tfsdk:"id"`
	Provider     types.String `tfsdk:"provider"`
	Domain       types.String `tfsdk:"domain"`
	ClientID     types.String `tfsdk:"client_id"`
	ClientSecret types.String `tfsdk:"client_secret"`
	MetadataURL  types.String `tfsdk:"metadata_url"`
	CreatedAt    types.String `tfsdk:"created_at"`
}

// ssoConfigResource is the resource implementation.
type ssoConfigResource struct {
	client *client.Client
}

// NewSSOConfigResource returns a new SSO config resource instance.
func NewSSOConfigResource() resource.Resource {
	return &ssoConfigResource{}
}

// Metadata returns the resource type name.
func (r *ssoConfigResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sso_config"
}

// Schema defines the schema for the resource.
func (r *ssoConfigResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Grantex SSO configuration. Configures single sign-on for your organization using an external identity provider.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "The unique identifier for the SSO configuration.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"provider": schema.StringAttribute{
				Description: "The SSO identity provider: 'okta', 'azure_ad', or 'google'.",
				Required:    true,
				Validators: []validator.String{
					stringvalidator.OneOf("okta", "azure_ad", "google"),
				},
			},
			"domain": schema.StringAttribute{
				Description: "The email domain for SSO (e.g., 'example.com').",
				Required:    true,
			},
			"client_id": schema.StringAttribute{
				Description: "The OAuth client ID from the identity provider.",
				Required:    true,
			},
			"client_secret": schema.StringAttribute{
				Description: "The OAuth client secret from the identity provider.",
				Required:    true,
				Sensitive:   true,
			},
			"metadata_url": schema.StringAttribute{
				Description: "The SAML/OIDC metadata URL from the identity provider.",
				Optional:    true,
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the SSO configuration was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
		},
	}
}

// Configure adds the provider configured client to the resource.
func (r *ssoConfigResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Resource Configure Type",
			fmt.Sprintf("Expected *client.Client, got: %T.", req.ProviderData),
		)
		return
	}

	r.client = c
}

// Create creates the resource and sets the initial Terraform state.
func (r *ssoConfigResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ssoConfigResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	upsertReq := client.UpsertSSOConfigRequest{
		Provider:     plan.Provider.ValueString(),
		Domain:       plan.Domain.ValueString(),
		ClientID:     plan.ClientID.ValueString(),
		ClientSecret: plan.ClientSecret.ValueString(),
	}
	if !plan.MetadataURL.IsNull() && !plan.MetadataURL.IsUnknown() {
		upsertReq.MetadataURL = plan.MetadataURL.ValueString()
	}

	config, err := r.client.UpsertSSOConfig(upsertReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error creating SSO configuration",
			"Could not create SSO configuration, unexpected error: "+err.Error(),
		)
		return
	}

	plan.ID = types.StringValue(config.ID)
	plan.CreatedAt = types.StringValue(config.CreatedAt)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Read refreshes the Terraform state with the latest data.
func (r *ssoConfigResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state ssoConfigResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config, err := r.client.GetSSOConfig()
	if err != nil {
		resp.Diagnostics.AddError(
			"Error reading SSO configuration",
			"Could not read SSO configuration: "+err.Error(),
		)
		return
	}

	state.ID = types.StringValue(config.ID)
	state.Provider = types.StringValue(config.Provider)
	state.Domain = types.StringValue(config.Domain)
	state.ClientID = types.StringValue(config.ClientID)
	// ClientSecret is not returned by the API; preserve state value.
	state.CreatedAt = types.StringValue(config.CreatedAt)

	if config.MetadataURL != "" {
		state.MetadataURL = types.StringValue(config.MetadataURL)
	} else {
		state.MetadataURL = types.StringNull()
	}

	diags = resp.State.Set(ctx, state)
	resp.Diagnostics.Append(diags...)
}

// Update updates the resource and sets the updated Terraform state on success.
func (r *ssoConfigResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan ssoConfigResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	upsertReq := client.UpsertSSOConfigRequest{
		Provider:     plan.Provider.ValueString(),
		Domain:       plan.Domain.ValueString(),
		ClientID:     plan.ClientID.ValueString(),
		ClientSecret: plan.ClientSecret.ValueString(),
	}
	if !plan.MetadataURL.IsNull() && !plan.MetadataURL.IsUnknown() {
		upsertReq.MetadataURL = plan.MetadataURL.ValueString()
	}

	config, err := r.client.UpsertSSOConfig(upsertReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error updating SSO configuration",
			"Could not update SSO configuration: "+err.Error(),
		)
		return
	}

	plan.ID = types.StringValue(config.ID)
	plan.CreatedAt = types.StringValue(config.CreatedAt)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete deletes the resource and removes the Terraform state on success.
func (r *ssoConfigResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	err := r.client.DeleteSSOConfig()
	if err != nil {
		resp.Diagnostics.AddError(
			"Error deleting SSO configuration",
			"Could not delete SSO configuration: "+err.Error(),
		)
		return
	}
}
