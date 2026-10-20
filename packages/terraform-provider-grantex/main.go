// Command terraform-provider-grantex is the Terraform provider for Grantex.
//
// License: PolyForm Noncommercial License 1.0.0 (see LICENSE), licensor
// Orchestrum Technologies LLP. Commercial use of any sort requires a written
// agreement with Orchestrum Technologies LLP. See
// https://github.com/mishrasanjeev/grantex/blob/main/COMMERCIAL-LICENSE.md.
package main

import (
	"context"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/mishrasanjeev/terraform-provider-grantex/internal/provider"
)

// version is set at build time via ldflags.
var version = "dev"

func main() {
	opts := providerserver.ServeOpts{
		Address: "registry.terraform.io/mishrasanjeev/grantex",
	}

	err := providerserver.Serve(context.Background(), provider.New(version), opts)
	if err != nil {
		log.Fatal(err.Error())
	}
}
