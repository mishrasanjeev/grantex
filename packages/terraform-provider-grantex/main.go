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
