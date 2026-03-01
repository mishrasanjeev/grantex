package datasources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ datasource.DataSource              = &grantsDataSource{}
	_ datasource.DataSourceWithConfigure = &grantsDataSource{}
)

// grantsDataSourceModel maps the data source schema data to a Go type.
type grantsDataSourceModel struct {
	AgentID     types.String `tfsdk:"agent_id"`
	PrincipalID types.String `tfsdk:"principal_id"`
	Status      types.String `tfsdk:"status"`
	Grants      types.List   `tfsdk:"grants"`
}

// grantsDataSource is the data source implementation.
type grantsDataSource struct {
	client *client.Client
}

// NewGrantsDataSource returns a new grants data source instance.
func NewGrantsDataSource() datasource.DataSource {
	return &grantsDataSource{}
}

// Metadata returns the data source type name.
func (d *grantsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_grants"
}

// grantObjectType returns the attr.Type for a grant object.
func grantObjectType() types.ObjectType {
	return types.ObjectType{
		AttrTypes: map[string]attr.Type{
			"grant_id":     types.StringType,
			"agent_id":     types.StringType,
			"principal_id": types.StringType,
			"scopes":       types.ListType{ElemType: types.StringType},
			"status":       types.StringType,
			"expires_at":   types.StringType,
			"created_at":   types.StringType,
		},
	}
}

// Schema defines the schema for the data source.
func (d *grantsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Use this data source to list Grantex grants with optional filters.",
		Attributes: map[string]schema.Attribute{
			"agent_id": schema.StringAttribute{
				Description: "Filter grants by agent ID.",
				Optional:    true,
			},
			"principal_id": schema.StringAttribute{
				Description: "Filter grants by principal (user) ID.",
				Optional:    true,
			},
			"status": schema.StringAttribute{
				Description: "Filter grants by status (e.g., 'active', 'revoked', 'expired').",
				Optional:    true,
			},
			"grants": schema.ListNestedAttribute{
				Description: "The list of grants matching the filters.",
				Computed:    true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"grant_id": schema.StringAttribute{
							Description: "The unique identifier for the grant.",
							Computed:    true,
						},
						"agent_id": schema.StringAttribute{
							Description: "The agent ID associated with the grant.",
							Computed:    true,
						},
						"principal_id": schema.StringAttribute{
							Description: "The principal (user) ID who authorized the grant.",
							Computed:    true,
						},
						"scopes": schema.ListAttribute{
							Description: "The scopes authorized in the grant.",
							Computed:    true,
							ElementType: types.StringType,
						},
						"status": schema.StringAttribute{
							Description: "The current status of the grant.",
							Computed:    true,
						},
						"expires_at": schema.StringAttribute{
							Description: "The timestamp when the grant expires.",
							Computed:    true,
						},
						"created_at": schema.StringAttribute{
							Description: "The timestamp when the grant was created.",
							Computed:    true,
						},
					},
				},
			},
		},
	}
}

// Configure adds the provider configured client to the data source.
func (d *grantsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Data Source Configure Type",
			fmt.Sprintf("Expected *client.Client, got: %T.", req.ProviderData),
		)
		return
	}

	d.client = c
}

// Read refreshes the Terraform state with the latest data.
func (d *grantsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config grantsDataSourceModel
	diags := req.Config.Get(ctx, &config)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Extract filter values.
	var agentID, principalID, status string
	if !config.AgentID.IsNull() && !config.AgentID.IsUnknown() {
		agentID = config.AgentID.ValueString()
	}
	if !config.PrincipalID.IsNull() && !config.PrincipalID.IsUnknown() {
		principalID = config.PrincipalID.ValueString()
	}
	if !config.Status.IsNull() && !config.Status.IsUnknown() {
		status = config.Status.ValueString()
	}

	grants, err := d.client.ListGrants(agentID, principalID, status)
	if err != nil {
		resp.Diagnostics.AddError(
			"Error listing grants",
			"Could not list grants: "+err.Error(),
		)
		return
	}

	// Convert API grants to Terraform object values.
	grantObjects := make([]attr.Value, 0, len(grants))
	for _, g := range grants {
		scopesList, diags := types.ListValueFrom(ctx, types.StringType, g.Scopes)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}

		grantObj, diags := types.ObjectValue(
			grantObjectType().AttrTypes,
			map[string]attr.Value{
				"grant_id":     types.StringValue(g.GrantID),
				"agent_id":     types.StringValue(g.AgentID),
				"principal_id": types.StringValue(g.PrincipalID),
				"scopes":       scopesList,
				"status":       types.StringValue(g.Status),
				"expires_at":   types.StringValue(g.ExpiresAt),
				"created_at":   types.StringValue(g.CreatedAt),
			},
		)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}

		grantObjects = append(grantObjects, grantObj)
	}

	grantsList, diags := types.ListValue(grantObjectType(), grantObjects)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	config.Grants = grantsList

	diags = resp.State.Set(ctx, config)
	resp.Diagnostics.Append(diags...)
}
