package resources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource              = &agentResource{}
	_ resource.ResourceWithConfigure = &agentResource{}
)

// agentResourceModel maps the resource schema data to a Go type.
type agentResourceModel struct {
	AgentID     types.String `tfsdk:"agent_id"`
	DID         types.String `tfsdk:"did"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Scopes      types.List   `tfsdk:"scopes"`
	Status      types.String `tfsdk:"status"`
	CreatedAt   types.String `tfsdk:"created_at"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

// agentResource is the resource implementation.
type agentResource struct {
	client *client.Client
}

// NewAgentResource returns a new agent resource instance.
func NewAgentResource() resource.Resource {
	return &agentResource{}
}

// Metadata returns the resource type name.
func (r *agentResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_agent"
}

// Schema defines the schema for the resource.
func (r *agentResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Grantex agent. Agents represent AI applications that request delegated authorization from principals.",
		Attributes: map[string]schema.Attribute{
			"agent_id": schema.StringAttribute{
				Description: "The unique identifier for the agent.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"did": schema.StringAttribute{
				Description: "The decentralized identifier (DID) for the agent.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				Description: "The display name of the agent.",
				Required:    true,
			},
			"description": schema.StringAttribute{
				Description: "A description of the agent's purpose.",
				Optional:    true,
			},
			"scopes": schema.ListAttribute{
				Description: "The list of scopes this agent can request.",
				Required:    true,
				ElementType: types.StringType,
			},
			"status": schema.StringAttribute{
				Description: "The current status of the agent.",
				Computed:    true,
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the agent was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"updated_at": schema.StringAttribute{
				Description: "The timestamp when the agent was last updated.",
				Computed:    true,
			},
		},
	}
}

// Configure adds the provider configured client to the resource.
func (r *agentResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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
func (r *agentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan agentResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Extract scopes from plan.
	var scopes []string
	diags = plan.Scopes.ElementsAs(ctx, &scopes, false)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	createReq := client.CreateAgentRequest{
		Name:   plan.Name.ValueString(),
		Scopes: scopes,
	}
	if !plan.Description.IsNull() && !plan.Description.IsUnknown() {
		createReq.Description = plan.Description.ValueString()
	}

	agent, err := r.client.CreateAgent(createReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error creating agent",
			"Could not create agent, unexpected error: "+err.Error(),
		)
		return
	}

	// Map response to state.
	plan.AgentID = types.StringValue(agent.AgentID)
	plan.DID = types.StringValue(agent.DID)
	plan.Status = types.StringValue(agent.Status)
	plan.CreatedAt = types.StringValue(agent.CreatedAt)
	plan.UpdatedAt = types.StringValue(agent.UpdatedAt)

	scopesList, diags := types.ListValueFrom(ctx, types.StringType, agent.Scopes)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	plan.Scopes = scopesList

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Read refreshes the Terraform state with the latest data.
func (r *agentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state agentResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	agent, err := r.client.GetAgent(state.AgentID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(
			"Error reading agent",
			"Could not read agent ID "+state.AgentID.ValueString()+": "+err.Error(),
		)
		return
	}

	state.AgentID = types.StringValue(agent.AgentID)
	state.DID = types.StringValue(agent.DID)
	state.Name = types.StringValue(agent.Name)
	if agent.Description != "" {
		state.Description = types.StringValue(agent.Description)
	} else {
		state.Description = types.StringNull()
	}
	state.Status = types.StringValue(agent.Status)
	state.CreatedAt = types.StringValue(agent.CreatedAt)
	state.UpdatedAt = types.StringValue(agent.UpdatedAt)

	scopesList, diags := types.ListValueFrom(ctx, types.StringType, agent.Scopes)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	state.Scopes = scopesList

	diags = resp.State.Set(ctx, state)
	resp.Diagnostics.Append(diags...)
}

// Update updates the resource and sets the updated Terraform state on success.
func (r *agentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan agentResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	var state agentResourceModel
	diags = req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	var scopes []string
	diags = plan.Scopes.ElementsAs(ctx, &scopes, false)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updateReq := client.UpdateAgentRequest{
		Name:   plan.Name.ValueString(),
		Scopes: scopes,
	}
	if !plan.Description.IsNull() && !plan.Description.IsUnknown() {
		updateReq.Description = plan.Description.ValueString()
	}

	agent, err := r.client.UpdateAgent(state.AgentID.ValueString(), updateReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error updating agent",
			"Could not update agent ID "+state.AgentID.ValueString()+": "+err.Error(),
		)
		return
	}

	plan.AgentID = types.StringValue(agent.AgentID)
	plan.DID = types.StringValue(agent.DID)
	plan.Status = types.StringValue(agent.Status)
	plan.CreatedAt = types.StringValue(agent.CreatedAt)
	plan.UpdatedAt = types.StringValue(agent.UpdatedAt)

	scopesList, diags := types.ListValueFrom(ctx, types.StringType, agent.Scopes)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	plan.Scopes = scopesList

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete deletes the resource and removes the Terraform state on success.
func (r *agentResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state agentResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteAgent(state.AgentID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(
			"Error deleting agent",
			"Could not delete agent ID "+state.AgentID.ValueString()+": "+err.Error(),
		)
		return
	}
}
