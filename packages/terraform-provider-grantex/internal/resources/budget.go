package resources

import (
	"context"
	"errors"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/float64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ resource.Resource                = &budgetAllocationResource{}
	_ resource.ResourceWithConfigure   = &budgetAllocationResource{}
	_ resource.ResourceWithImportState = &budgetAllocationResource{}
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
		Description: "Manages a Grantex budget allocation. Allocates a spending budget to a grant for cost control. The API offers no update or delete for allocations: every configurable attribute forces replacement, and destroying the resource only removes it from Terraform state.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "The unique identifier for the budget allocation.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"grant_id": schema.StringAttribute{
				Description: "The grant ID to allocate budget to. Changing this forces a new resource.",
				Required:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"initial_budget": schema.Float64Attribute{
				Description: "The initial budget amount to allocate. Changing this forces a new resource; because the API keeps the existing allocation for the grant, the replacement will be refused (409) until that allocation is removed out of band.",
				Required:    true,
				PlanModifiers: []planmodifier.Float64{
					float64planmodifier.RequiresReplace(),
				},
			},
			"remaining_budget": schema.Float64Attribute{
				Description: "The remaining budget amount.",
				Computed:    true,
			},
			"currency": schema.StringAttribute{
				Description: "The currency for the budget. Defaults to 'USD'. Changing this forces a new resource.",
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

// applyBudgetAllocation copies an API allocation into the model, parsing the
// string-encoded NUMERIC(18,4) amounts.
func applyBudgetAllocation(model *budgetAllocationResourceModel, alloc *client.BudgetAllocation) error {
	initial, err := alloc.InitialBudgetFloat()
	if err != nil {
		return err
	}
	remaining, err := alloc.RemainingBudgetFloat()
	if err != nil {
		return err
	}

	model.ID = types.StringValue(alloc.ID)
	model.GrantID = types.StringValue(alloc.GrantID)
	model.InitialBudget = types.Float64Value(initial)
	model.RemainingBudget = types.Float64Value(remaining)
	model.Currency = types.StringValue(alloc.Currency)
	model.CreatedAt = types.StringValue(alloc.CreatedAt)
	return nil
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
		var apiErr *client.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == 409 && apiErr.Code == "CONFLICT" {
			resp.Diagnostics.AddError(
				"Budget allocation already exists for this grant",
				"Grant "+plan.GrantID.ValueString()+" already has a budget allocation and the Grantex API does not support "+
					"updating or deleting allocations. Import the existing allocation instead: "+
					"terraform import <address> "+plan.GrantID.ValueString()+". API error: "+err.Error(),
			)
			return
		}
		resp.Diagnostics.AddError(
			"Error creating budget allocation",
			"Could not create budget allocation, unexpected error: "+err.Error(),
		)
		return
	}

	if err := applyBudgetAllocation(&plan, alloc); err != nil {
		resp.Diagnostics.AddError(
			"Error decoding budget allocation",
			"The allocation was created but its response could not be decoded: "+err.Error(),
		)
		return
	}

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
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError(
			"Error reading budget allocation",
			"Could not read budget allocation for grant "+state.GrantID.ValueString()+": "+err.Error(),
		)
		return
	}

	if err := applyBudgetAllocation(&state, alloc); err != nil {
		resp.Diagnostics.AddError(
			"Error decoding budget allocation",
			"Could not decode budget allocation for grant "+state.GrantID.ValueString()+": "+err.Error(),
		)
		return
	}

	diags = resp.State.Set(ctx, state)
	resp.Diagnostics.Append(diags...)
}

// Update is never reached: grant_id, initial_budget and currency all force
// replacement and the remaining attributes are computed. It exists only to
// satisfy resource.Resource and carries the planned values forward.
func (r *budgetAllocationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan budgetAllocationResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

// Delete performs a logical delete of the budget allocation.
// The API does not support deleting budget allocations, so this only removes
// the resource from Terraform state; the allocation remains on the grant.
func (r *budgetAllocationResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state budgetAllocationResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	resp.Diagnostics.AddWarning(
		"Budget allocation removed from state only",
		"The Grantex API does not support deleting budget allocations. The allocation for grant "+
			state.GrantID.ValueString()+" remains in Grantex and is no longer tracked by Terraform.",
	)
}

// ImportState imports an allocation by its grant ID (the balance endpoint is
// keyed by grant, and each grant has at most one allocation).
func (r *budgetAllocationResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("grant_id"), req, resp)
}
