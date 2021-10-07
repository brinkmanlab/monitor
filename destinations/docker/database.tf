resource "docker_image" "dynamodb" {
  name = "amazon/dynamodb-local"
}

resource "docker_container" "dynamodb" {
  name = "dynamodb"
  image = docker_image.dynamodb.latest
  hostname = "dynamodb"
  domainname = "dynamodb"
  restart = "unless-stopped"
  must_run = true

  networks_advanced {
    name = docker_network.monitor.name
    aliases = ["dynamodb"]
  }
}
