package resources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource              = &budgetAllocationResource{}
	_ resource.ResourceWithConfigure = &budgetAllocationResource{}
)

// budgetAllocationResourceModel maps the resource schema data to a Go type.
type budgetAllocationResourceModel struct {
	ID              types.String  `tfsdk:"id"`
	GrantID         types.String  `tfsdk:"grant_id"`
	InitialBudget   types.Float64 `tfsdk:"initial_budget"`
	RemainingBudget types.Float64 `tfsdk:"remaining_budget"`
	Currency        types.String  `tfsdk:"currency"`
	CreatedAt       types.String  `tfsdk:"created_at"`
}

// budgetAllocationResource is the resource implementation.
type budgetAllocationResource struct {
	client *client.Client
}

// NewBudgetAllocationResource returns a new budget allocation resource instance.
func NewBudgetAllocationResource() resource.Resource {
	return &budgetAllocationResource{}
}

// Metadata returns the resource type name.
func (r *budgetAllocationResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_budget_allocation"
}

// Schema defines the schema for the resource.
func (r *budgetAllocationResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Grantex budget allocation. Allocates a spending budget to a grant for cost control. This resource is create-only; updates are not supported.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "The unique identifier for the budget allocation.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"grant_id": schema.StringAttribute{
				Description: "The grant ID to allocate budget to.",
				Required:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"initial_budget": schema.Float64Attribute{
				Description: "The initial budget amount to allocate.",
				Required:    true,
			},
			"remaining_budget": schema.Float64Attribute{
				Description: "The remaining budget amount.",
				Computed:    true,
			},
			"currency": schema.StringAttribute{
				Description: "The currency for the budget. Defaults to 'USD'.",
				Optional:    true,
				Computed:    true,
				Default:     stringdefault.StaticString("USD"),
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the budget allocation was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
		},
	}
}

// Configure adds the provider configured client to the resource.
func (r *budgetAllocationResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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
func (r *budgetAllocationResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan budgetAllocationResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	createReq := client.CreateBudgetAllocationRequest{
		GrantID:       plan.GrantID.ValueString(),
		InitialBudget: plan.InitialBudget.ValueFloat64(),
		Currency:      plan.Currency.ValueString(),
	}

	alloc, err := r.client.CreateBudgetAllocation(createReq)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error creating budget allocation",
			"Could not create budget allocation, unexpected error: "+err.Error(),
		)
		return
	}

	plan.ID = types.StringValue(alloc.ID)
	plan.RemainingBudget = types.Float64Value(alloc.RemainingBudget)
	plan.CreatedAt = types.StringValue(alloc.CreatedAt)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Read refreshes the Terraform state with the latest data.
func (r *budgetAllocationResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state budgetAllocationResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	alloc, err := r.client.GetBudgetBalance(state.GrantID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(
			"Error reading budget allocation",
			"Could not read budget allocation for grant "+state.GrantID.ValueString()+": "+err.Error(),
		)
		return
	}

	state.ID = types.StringValue(alloc.ID)
	state.GrantID = types.StringValue(alloc.GrantID)
	state.InitialBudget = types.Float64Value(alloc.InitialBudget)
	state.RemainingBudget = types.Float64Value(alloc.RemainingBudget)
	state.Currency = types.StringValue(alloc.Currency)
	state.CreatedAt = types.StringValue(alloc.CreatedAt)

	diags = resp.State.Set(ctx, state)
	resp.Diagnostics.Append(diags...)
}

// Update is a no-op for budget allocations (create-only resource).
// Changes to grant_id or currency trigger RequiresReplace, so this should
// only be called if initial_budget changes, which we accept as a no-op.
func (r *budgetAllocationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan budgetAllocationResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	resp.Diagnostics.AddWarning(
		"Budget allocation update not supported",
		"Budget allocations are create-only. To change the budget, destroy and recreate the resource.",
	)

	// Preserve the existing state with the new plan values.
	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete performs a logical delete of the budget allocation.
// The API does not support deleting budget allocations, so this is a no-op
// that simply removes the resource from Terraform state.
func (r *budgetAllocationResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
	// Logical delete: remove from state only.
	// The budget allocation remains in the Grantex API but is no longer tracked.
}
