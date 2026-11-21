package provider

func init() {
	registerDatabase(dbKind{
		Name:         "mariadb",
		Title:        "MariaDB",
		ImageExample: "mariadb:11",
		DataPath:     "/var/lib/mysql",
		DatabaseName: true,
		DatabaseUser: true,
		RootPassword: true,
	})
}
