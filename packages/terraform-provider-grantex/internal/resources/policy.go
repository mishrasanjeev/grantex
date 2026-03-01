package resources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource              = &policyResource{}
	_ resource.ResourceWithConfigure = &policyResource{}
)

// policyResourceModel maps the resource schema data to a Go type.
type policyResourceModel struct {
	ID             types.String `tfsdk:"id"`
	Name           types.String `tfsdk:"name"`
	Effect         types.String `tfsdk:"effect"`
	Priority       types.Int64  `tfsdk:"priority"`
	AgentID        types.String `tfsdk:"agent_id"`
	PrincipalID    types.String `tfsdk:"principal_id"`
	Scopes         types.List   `tfsdk:"scopes"`
	TimeOfDayStart types.String `tfsdk:"time_of_day_start"`
	TimeOfDayEnd   types.String `tfsdk:"time_of_day_end"`
	CreatedAt      types.String `tfsdk:"created_at"`
	UpdatedAt      types.String `tfsdk:"updated_at"`
}

// policyResource is the resource implementation.
type policyResource struct {
	client *client.Client
}

// NewPolicyResource returns a new policy resource instance.
func NewPolicyResource() resource.Resource {
	return &policyResource{}
}

// Metadata returns the resource type name.
func (r *policyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_policy"
}

// Schema defines the schema for the resource.
func (r *policyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Grantex authorization policy. Policies define allow or deny rules for agent access.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "The unique identifier for the policy.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				Description: "The name of the policy.",
				Required:    true,
			},
			"effect": schema.StringAttribute{
				Description: "The effect of the policy: 'allow' or 'deny'.",
				Required:    true,
				Validators: []validator.String{
					stringvalidator.OneOf("allow", "deny"),
				},
			},
			"priority": schema.Int64Attribute{
				Description: "The priority of the policy. Higher values take precedence. Defaults to 0.",
				Optional:    true,
				Computed:    true,
				Default:     int64default.StaticInt64(0),
			},
			"agent_id": schema.StringAttribute{
				Description: "The agent ID this policy applies to. If omitted, applies to all agents.",
				Optional:    true,
			},
			"principal_id": schema.StringAttribute{
				Description: "The principal ID this policy applies to. If omitted, applies to all principals.",
				Optional:    true,
			},
			"scopes": schema.ListAttribute{
				Description: "The scopes this policy applies to. If omitted, applies to all scopes.",
				Optional:    true,
				ElementType: types.StringType,
			},
			"time_of_day_start": schema.StringAttribute{
				Description: "Start time for time-based policy (HH:MM format, UTC).",
				Optional:    true,
			},
			"time_of_day_end": schema.StringAttribute{
				Description: "End time for time-based policy (HH:MM format, UTC).",
				Optional:    true,
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the policy was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"updated_at": schema.StringAttribute{
				Description: "The timestamp when the policy was last updated.",
				Computed:    true,
			},
		},
	}
}

// Configure adds the provider configured client to the resource.
func (r *policyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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
func (r *policyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan policyResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	createReq := client.CreatePolicyRequest{
		Name:     plan.Name.ValueString(),
		Effect:   plan.Effect.ValueString(),
		Priority: plan.Priority.ValueInt64(),
	}

	if !plan.AgentID.IsNull() && !plan.AgentID.IsUnknown() {
		createReq.AgentID = plan.AgentID.ValueString()
	}
	if !plan.PrincipalID.IsNull() && !plan.PrincipalID.IsUnknown() {
		createReq.PrincipalID = plan.PrincipalID.ValueString()
	}
	if !plan.TimeOfDayStart.IsNull() && !plan.TimeOfDayStart.IsUnknown() {
		createReq.TimeOfDayStart = plan.TimeOfDayStart.ValueString()
	}
	if !plan.TimeOfDayEnd.IsNull() && !plan.TimeOfDayEnd.IsUnknown() {
		createReq.TimeOfDayEnd = plan.TimeOfDayEnd.ValueString()
	}

	if !plan.Scopes.IsNull() && !plan.Scopes.IsUnknown() {
		var scopes []string
		diags = plan.Scopes.ElementsAs(ctx, &scopes, false)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}
		createReq.Scopes = scopes
	}

	policy, err := r.client.CreatePolicy(createReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error creating policy",
			"Could not create policy, unexpected error: "+err.Error(),
		)
		return
	}

	plan.ID = types.StringValue(policy.ID)
	plan.CreatedAt = types.StringValue(policy.CreatedAt)
	plan.UpdatedAt = types.StringValue(policy.UpdatedAt)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Read refreshes the Terraform state with the latest data.
func (r *policyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state policyResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	policy, err := r.client.GetPolicy(state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(
			"Error reading policy",
			"Could not read policy ID "+state.ID.ValueString()+": "+err.Error(),
		)
		return
	}

	state.ID = types.StringValue(policy.ID)
	state.Name = types.StringValue(policy.Name)
	state.Effect = types.StringValue(policy.Effect)
	state.Priority = types.Int64Value(policy.Priority)
	state.CreatedAt = types.StringValue(policy.CreatedAt)
	state.UpdatedAt = types.StringValue(policy.UpdatedAt)

	if policy.AgentID != "" {
		state.AgentID = types.StringValue(policy.AgentID)
	} else {
		state.AgentID = types.StringNull()
	}
	if policy.PrincipalID != "" {
		state.PrincipalID = types.StringValue(policy.PrincipalID)
	} else {
		state.PrincipalID = types.StringNull()
	}
	if policy.TimeOfDayStart != "" {
		state.TimeOfDayStart = types.StringValue(policy.TimeOfDayStart)
	} else {
		state.TimeOfDayStart = types.StringNull()
	}
	if policy.TimeOfDayEnd != "" {
		state.TimeOfDayEnd = types.StringValue(policy.TimeOfDayEnd)
	} else {
		state.TimeOfDayEnd = types.StringNull()
	}

	if len(policy.Scopes) > 0 {
		scopesList, diags := types.ListValueFrom(ctx, types.StringType, policy.Scopes)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}
		state.Scopes = scopesList
	} else {
		state.Scopes = types.ListNull(types.StringType)
	}

	diags = resp.State.Set(ctx, state)
	resp.Diagnostics.Append(diags...)
}

// Update updates the resource and sets the updated Terraform state on success.
func (r *policyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan policyResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	var state policyResourceModel
	diags = req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updateReq := client.UpdatePolicyRequest{
		Name:     plan.Name.ValueString(),
		Effect:   plan.Effect.ValueString(),
		Priority: plan.Priority.ValueInt64(),
	}

	if !plan.AgentID.IsNull() && !plan.AgentID.IsUnknown() {
		updateReq.AgentID = plan.AgentID.ValueString()
	}
	if !plan.PrincipalID.IsNull() && !plan.PrincipalID.IsUnknown() {
		updateReq.PrincipalID = plan.PrincipalID.ValueString()
	}
	if !plan.TimeOfDayStart.IsNull() && !plan.TimeOfDayStart.IsUnknown() {
		updateReq.TimeOfDayStart = plan.TimeOfDayStart.ValueString()
	}
	if !plan.TimeOfDayEnd.IsNull() && !plan.TimeOfDayEnd.IsUnknown() {
		updateReq.TimeOfDayEnd = plan.TimeOfDayEnd.ValueString()
	}

	if !plan.Scopes.IsNull() && !plan.Scopes.IsUnknown() {
		var scopes []string
		diags = plan.Scopes.ElementsAs(ctx, &scopes, false)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}
		updateReq.Scopes = scopes
	}

	policy, err := r.client.UpdatePolicy(state.ID.ValueString(), updateReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error updating policy",
			"Could not update policy ID "+state.ID.ValueString()+": "+err.Error(),
		)
		return
	}

	plan.ID = types.StringValue(policy.ID)
	plan.CreatedAt = types.StringValue(policy.CreatedAt)
	plan.UpdatedAt = types.StringValue(policy.UpdatedAt)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete deletes the resource and removes the Terraform state on success.
func (r *policyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state policyResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeletePolicy(state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(
			"Error deleting policy",
			"Could not delete policy ID "+state.ID.ValueString()+": "+err.Error(),
		)
		return
	}
}
