package provider

func init() {
	registerDatabase(dbKind{
		Name:         "mongo",
		Title:        "MongoDB",
		ImageExample: "mongo:8",
		DataPath:     "/data/db",
		DatabaseUser: true,
		Extra: []Field{
			{Name: "replica_sets", Kind: Bool, Desc: "Run MongoDB as a single-node replica set (needed for transactions and change streams)."},
		},
		ExtraCreate: []string{"replicaSets"},
	})
}
