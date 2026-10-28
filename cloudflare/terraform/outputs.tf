output "experiment_engine_worker_name" {
  value = cloudflare_worker.experiment_engine.name
}

output "experiment_runtime_worker_names" {
  value = { for id, worker in cloudflare_worker.runtime : id => worker.name }
}

output "experiment_index_d1_database_id" {
  value = cloudflare_d1_database.experiment_index.id
}

output "experiment_packages_r2_bucket_name" {
  value = cloudflare_r2_bucket.experiment_packages.name
}

output "experiment_artifacts_r2_bucket_name" {
  value = cloudflare_r2_bucket.experiment_artifacts.name
}

output "secrets_store_id" {
  value = cloudflare_secrets_store.swarm.id
}
