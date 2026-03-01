package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/client"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/datasources"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/resources"
)

// Ensure the implementation satisfies the expected interfaces.
var (
	_ provider.Provider = &grantexProvider{}
)

// grantexProviderModel maps provider schema data to a Go type.
type grantexProviderModel struct {
	APIKey  types.String `tfsdk:"api_key"`
	BaseURL types.String `tfsdk:"base_url"`
}

// grantexProvider is the provider implementation.
type grantexProvider struct {
	version string
}

// New returns a function that creates a new provider instance.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &grantexProvider{
			version: version,
		}
	}
}

// Metadata returns the provider type name.
func (p *grantexProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "grantex"
	resp.Version = p.version
}

// Schema defines the provider-level schema for configuration data.
func (p *grantexProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The Grantex provider is used to manage Grantex resources for delegated authorization of AI agents.",
		Attributes: map[string]schema.Attribute{
			"api_key": schema.StringAttribute{
				Description: "The API key for authenticating with the Grantex API. Can also be set via the GRANTEX_API_KEY environment variable.",
				Optional:    true,
				Sensitive:   true,
			},
			"base_url": schema.StringAttribute{
				Description: "The base URL for the Grantex API. Defaults to https://api.grantex.dev.",
				Optional:    true,
			},
		},
	}
}

// Configure prepares a Grantex API client for data sources and resources.
func (p *grantexProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config grantexProviderModel
	diags := req.Config.Get(ctx, &config)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Resolve API key: config value takes precedence over environment variable.
	apiKey := os.Getenv("GRANTEX_API_KEY")
	if !config.APIKey.IsNull() && !config.APIKey.IsUnknown() {
		apiKey = config.APIKey.ValueString()
	}

	if apiKey == "" {
		resp.Diagnostics.AddError(
			"Missing API Key",
			"The provider requires an API key. Set the api_key attribute in the provider configuration or the GRANTEX_API_KEY environment variable.",
		)
		return
	}

	// Resolve base URL: config value takes precedence over default.
	baseURL := "https://api.grantex.dev"
	if !config.BaseURL.IsNull() && !config.BaseURL.IsUnknown() {
		baseURL = config.BaseURL.ValueString()
	}

	// Create the API client.
	c := client.NewClient(apiKey, baseURL)

	// Make the client available to resources and data sources.
	resp.DataSourceData = c
	resp.ResourceData = c
}

// Resources defines the resources implemented in the provider.
func (p *grantexProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		resources.NewAgentResource,
		resources.NewPolicyResource,
		resources.NewWebhookResource,
		resources.NewSSOConfigResource,
		resources.NewBudgetAllocationResource,
	}
}

// DataSources defines the data sources implemented in the provider.
func (p *grantexProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		datasources.NewAgentDataSource,
		datasources.NewGrantsDataSource,
	}
}
