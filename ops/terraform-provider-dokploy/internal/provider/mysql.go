package provider

func init() {
	registerDatabase(dbKind{
		Name:         "mysql",
		Title:        "MySQL",
		ImageExample: "mysql:8",
		DataPath:     "/var/lib/mysql",
		DatabaseName: true,
		DatabaseUser: true,
		RootPassword: true,
	})
}
