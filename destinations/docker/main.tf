locals {
  env = join(" ", [for k, v in local.config : "-e ${k}"])
  code_path = abspath("${path.module}/../../index.js")
}

resource "docker_image" "cron" {
  name = "alpinelinux/docker-cli"
}

resource "docker_network" "monitor" {
  name = "monitor"
}

resource "docker_container" "cron" {
  name = "monitor_cron"
  image = docker_image.cron.latest
  restart = "unless-stopped"
  must_run = true
  group_add  = [var.docker_gid]

  command = ["crond", "-f", "-d", "8"]

  # TODO provide smtp config

  # environment variables passed through to docker run command to avoid injecting values in crontab command
  env = compact(concat(
    ["ENDPOINT=dynamodb"],
    [for k, v in local.config : "${k}=${v}"],
  )),

  upload {
    file = "/etc/crontabs/root"
    content = "${var.poll_rate} * * * * docker run --rm --name monitor --network ${docker_network.monitor.name} -v ${local.code_path}:/var/task/index.js:ro -e ENDPOINT ${local.env} amazon/aws-lambda-nodejs index.poll > /proc/1/fd/1 2> /proc/1/fd/2"
  }

  networks_advanced {
    name = docker_network.monitor.name
    aliases = ["monitor"]
  }

  mounts {
    target = var.docker_socket_path
    source = var.docker_socket_path
    type   = "bind"
  }
}
