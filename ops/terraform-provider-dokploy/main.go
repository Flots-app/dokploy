// Command terraform-provider-dokploy is the internal Terraform provider of the
// Flots Dokploy fork.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/provider"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

// address is the source address of the provider in Terraform configurations.
// It is served from a filesystem mirror, never from a public registry.
const address = "registry.flots.app/flots-app/dokploy"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with debugger support")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: address,
		Debug:   debug,
	})
	if err != nil {
		// Terraform shows what a plugin writes to stderr when it fails to start.
		fmt.Fprintf(os.Stderr, "terraform-provider-dokploy: %v\n", err)
		os.Exit(1)
	}
}
