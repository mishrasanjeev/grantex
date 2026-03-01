package datasources

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ datasource.DataSource              = &agentDataSource{}
	_ datasource.DataSourceWithConfigure = &agentDataSource{}
)

// agentDataSourceModel maps the data source schema data to a Go type.
type agentDataSourceModel struct {
	AgentID     types.String `tfsdk:"agent_id"`
	DID         types.String `tfsdk:"did"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Scopes      types.List   `tfsdk:"scopes"`
	Status      types.String `tfsdk:"status"`
	CreatedAt   types.String `tfsdk:"created_at"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

// agentDataSource is the data source implementation.
type agentDataSource struct {
	client *client.Client
}

// NewAgentDataSource returns a new agent data source instance.
func NewAgentDataSource() datasource.DataSource {
	return &agentDataSource{}
}

// Metadata returns the data source type name.
func (d *agentDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_agent"
}

// Schema defines the schema for the data source.
func (d *agentDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Use this data source to look up an existing Grantex agent by its ID.",
		Attributes: map[string]schema.Attribute{
			"agent_id": schema.StringAttribute{
				Description: "The unique identifier of the agent to look up.",
				Required:    true,
			},
			"did": schema.StringAttribute{
				Description: "The decentralized identifier (DID) for the agent.",
				Computed:    true,
			},
			"name": schema.StringAttribute{
				Description: "The display name of the agent.",
				Computed:    true,
			},
			"description": schema.StringAttribute{
				Description: "A description of the agent's purpose.",
				Computed:    true,
			},
			"scopes": schema.ListAttribute{
				Description: "The list of scopes this agent can request.",
				Computed:    true,
				ElementType: types.StringType,
			},
			"status": schema.StringAttribute{
				Description: "The current status of the agent.",
				Computed:    true,
			},
			"created_at": schema.StringAttribute{
				Description: "The timestamp when the agent was created.",
				Computed:    true,
			},
			"updated_at": schema.StringAttribute{
				Description: "The timestamp when the agent was last updated.",
				Computed:    true,
			},
		},
	}
}

// Configure adds the provider configured client to the data source.
func (d *agentDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
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
func (d *agentDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config agentDataSourceModel
	diags := req.Config.Get(ctx, &config)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	agent, err := d.client.GetAgent(config.AgentID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError(
			"Error reading agent",
			"Could not read agent ID "+config.AgentID.ValueString()+": "+err.Error(),
		)
		return
	}

	config.AgentID = types.StringValue(agent.AgentID)
	config.DID = types.StringValue(agent.DID)
	config.Name = types.StringValue(agent.Name)
	config.Status = types.StringValue(agent.Status)
	config.CreatedAt = types.StringValue(agent.CreatedAt)
	config.UpdatedAt = types.StringValue(agent.UpdatedAt)

	if agent.Description != "" {
		config.Description = types.StringValue(agent.Description)
	} else {
		config.Description = types.StringNull()
	}

	scopesList, diags := types.ListValueFrom(ctx, types.StringType, agent.Scopes)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	config.Scopes = scopesList

	diags = resp.State.Set(ctx, config)
	resp.Diagnostics.Append(diags...)
}
