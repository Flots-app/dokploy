package provider

func init() {
	registerDatabase(dbKind{
		Name:         "postgres",
		Title:        "PostgreSQL",
		ImageExample: "postgres:17",
		DataPath:     "/var/lib/postgresql/data",
		DatabaseName: true,
		DatabaseUser: true,
	})
}
