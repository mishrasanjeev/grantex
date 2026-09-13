package resources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource                = &webhookResource{}
	_ resource.ResourceWithConfigure   = &webhookResource{}
	_ resource.ResourceWithImportState = &webhookResource{}
)

// webhookResourceModel maps the resource schema data to a Go type.
type webhookResourceModel struct {
	ID        types.String `tfsdk:"id"`
	URL       types.String `tfsdk:"url"`
	Events    types.List   `tfsdk:"events"`
	Secret    types.String `tfsdk:"secret"`
	CreatedAt types.String `tfsdk:"created_at"`
}

// webhookResource is the resource implementation.
type webhookResource struct {
	client *client.Client
}

// NewWebhookResource returns a new webhook resource instance.
func NewWebhookResource() resource.Resource {
	return &webhookResource{}
}

// Metadata returns the resource type name.
func (r *webhookResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_webhook"
}

// Schema defines the schema for the resource.
//
// The Grantex API exposes POST /v1/webhooks, GET /v1/webhooks and
// DELETE /v1/webhooks/:id only: there is no per-webhook GET or PATCH. Every
// configurable attribute therefore forces replacement, and the signing secret
// is generated server-side and returned once, on creation.
func (r *webhookResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Grantex webhook. Webhooks deliver real-time event notifications to your application. Webhooks cannot be updated in place: changing url or events replaces the webhook (and rotates its secret).",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "The unique identifier for the webhook.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"url": schema.StringAttribute{
				Description: "The URL to deliver webhook events to. Changing this forces a new resource.",
				Required:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"events": schema.ListAttribute{
				Description: "The list of event types to subscribe to: 'grant.created', 'grant.revoked', 'token.issued'. Changing this forces a new resource.",
				Required:    true,
				ElementType: types.StringType,
				PlanModifiers: []planmodifier.List{
					listplanmodifier.RequiresReplace(),
				},
			},
			"secret": schema.StringAttribute{
				Description: "The server-generated secret used to sign webhook payloads (HMAC-SHA256). Returned only when the webhook is created; it is not recoverable afterwards.",
				Computed:    true,
				Sensitive:   true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the webhook was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
		},
	}
}

// Configure adds the provider configured client to the resource.
func (r *webhookResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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
func (r *webhookResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan webhookResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	var events []string
	diags = plan.Events.ElementsAs(ctx, &events, false)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	webhook, err := r.client.CreateWebhook(client.CreateWebhookRequest{
		URL:    plan.URL.ValueString(),
		Events: events,
	})
	if err != nil {
		resp.Diagnostics.AddError(
			"Error creating webhook",
			"Could not create webhook, unexpected error: "+err.Error(),
		)
		return
	}

	plan.ID = types.StringValue(webhook.ID)
	plan.CreatedAt = types.StringValue(webhook.CreatedAt)
	// The secret is only ever returned by the create response.
	plan.Secret = types.StringValue(webhook.Secret)

	eventsList, diags := types.ListValueFrom(ctx, types.StringType, webhook.Events)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	plan.Events = eventsList

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Read refreshes the Terraform state with the latest data.
func (r *webhookResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state webhookResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// There is no GET /v1/webhooks/:id; the client lists and finds by id.
	webhook, err := r.client.GetWebhook(state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError(
			"Error reading webhook",
			"Could not read webhook ID "+state.ID.ValueString()+": "+err.Error(),
		)
		return
	}

	state.ID = types.StringValue(webhook.ID)
	state.URL = types.StringValue(webhook.URL)
	state.CreatedAt = types.StringValue(webhook.CreatedAt)
	// The list endpoint never returns the secret; keep whatever state holds
	// (the value captured at create time, or null after an import).

	eventsList, diags := types.ListValueFrom(ctx, types.StringType, webhook.Events)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	state.Events = eventsList

	diags = resp.State.Set(ctx, state)
	resp.Diagnostics.Append(diags...)
}

// Update is never reached: the API has no PATCH /v1/webhooks/:id and every
// configurable attribute is marked RequiresReplace. It is implemented only to
// satisfy resource.Resource and simply carries the planned values forward.
func (r *webhookResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan webhookResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete deletes the resource and removes the Terraform state on success.
func (r *webhookResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state webhookResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteWebhook(state.ID.ValueString())
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError(
			"Error deleting webhook",
			"Could not delete webhook ID "+state.ID.ValueString()+": "+err.Error(),
		)
		return
	}
}

// ImportState imports a webhook by its ID. The signing secret cannot be
// recovered from the API, so it stays null after import.
func (r *webhookResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
