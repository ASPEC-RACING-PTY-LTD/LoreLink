package main

import (
	"os"

	"lorelink.dev/lorelink/internal/cli"
)

func main() {
	os.Exit(cli.Execute(os.Args))
}
