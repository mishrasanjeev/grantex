package resources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// ssoConfigID is the fixed resource id. The API keeps exactly one SSO
// configuration per organisation and returns no identifier for it, so the
// singleton is addressed by a constant.
const ssoConfigID = "default"

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource                = &ssoConfigResource{}
	_ resource.ResourceWithConfigure   = &ssoConfigResource{}
	_ resource.ResourceWithImportState = &ssoConfigResource{}
)

// ssoConfigResourceModel maps the resource schema data to a Go type.
type ssoConfigResourceModel struct {
	ID           types.String `tfsdk:"id"`
	IssuerURL    types.String `tfsdk:"issuer_url"`
	ClientID     types.String `tfsdk:"client_id"`
	ClientSecret types.String `tfsdk:"client_secret"`
	RedirectURI  types.String `tfsdk:"redirect_uri"`
	CreatedAt    types.String `tfsdk:"created_at"`
	UpdatedAt    types.String `tfsdk:"updated_at"`
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

// Schema defines the schema for the resource. It mirrors POST/GET /v1/sso/config,
// which accepts {issuerUrl, clientId, clientSecret, redirectUri} and returns
// {issuerUrl, clientId, redirectUri, createdAt, updatedAt}.
func (r *ssoConfigResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages the organisation's OIDC SSO configuration. Only one SSO configuration exists per organisation; creating this resource replaces any existing configuration.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "The resource identifier. Always 'default', because the API holds a single SSO configuration per organisation.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"issuer_url": schema.StringAttribute{
				Description: "The OIDC issuer URL of the identity provider (e.g. 'https://example.okta.com').",
				Required:    true,
			},
			"client_id": schema.StringAttribute{
				Description: "The OAuth client ID from the identity provider.",
				Required:    true,
			},
			"client_secret": schema.StringAttribute{
				Description: "The OAuth client secret from the identity provider. Never returned by the API; the configured value is kept in state.",
				Required:    true,
				Sensitive:   true,
			},
			"redirect_uri": schema.StringAttribute{
				Description: "The redirect URI registered with the identity provider for the SSO callback.",
				Required:    true,
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the SSO configuration was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"updated_at": schema.StringAttribute{
				Description: "The timestamp when the SSO configuration was last updated.",
				Computed:    true,
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

func (r *ssoConfigResource) upsert(ctx context.Context, plan *ssoConfigResourceModel) (*client.SSOConfig, error) {
	return r.client.UpsertSSOConfig(client.UpsertSSOConfigRequest{
		IssuerURL:    plan.IssuerURL.ValueString(),
		ClientID:     plan.ClientID.ValueString(),
		ClientSecret: plan.ClientSecret.ValueString(),
		RedirectURI:  plan.RedirectURI.ValueString(),
	})
}

func applySSOConfig(model *ssoConfigResourceModel, config *client.SSOConfig) {
	model.ID = types.StringValue(ssoConfigID)
	model.IssuerURL = types.StringValue(config.IssuerURL)
	model.ClientID = types.StringValue(config.ClientID)
	model.RedirectURI = types.StringValue(config.RedirectURI)
	model.CreatedAt = types.StringValue(config.CreatedAt)
	model.UpdatedAt = types.StringValue(config.UpdatedAt)
	// ClientSecret is never returned by the API; the model keeps its value.
}

// Create creates the resource and sets the initial Terraform state.
func (r *ssoConfigResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ssoConfigResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config, err := r.upsert(ctx, &plan)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error creating SSO configuration",
			"Could not create SSO configuration, unexpected error: "+err.Error(),
		)
		return
	}

	applySSOConfig(&plan, config)

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
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError(
			"Error reading SSO configuration",
			"Could not read SSO configuration: "+err.Error(),
		)
		return
	}

	applySSOConfig(&state, config)

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

	config, err := r.upsert(ctx, &plan)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error updating SSO configuration",
			"Could not update SSO configuration: "+err.Error(),
		)
		return
	}

	applySSOConfig(&plan, config)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete deletes the resource and removes the Terraform state on success.
func (r *ssoConfigResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	err := r.client.DeleteSSOConfig()
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(
			"Error deleting SSO configuration",
			"Could not delete SSO configuration: "+err.Error(),
		)
		return
	}
}

// ImportState imports the organisation's single SSO configuration. Any import
// id is accepted and normalised to 'default'. client_secret cannot be read
// back from the API, so it must be set in configuration after import.
func (r *ssoConfigResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), ssoConfigID)...)
}
