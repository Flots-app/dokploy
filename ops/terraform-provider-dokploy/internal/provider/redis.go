package provider

func init() {
	registerDatabase(dbKind{
		Name:         "redis",
		Title:        "Redis",
		ImageExample: "redis:7",
		DataPath:     "/data",
	})
}
