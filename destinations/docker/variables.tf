variable "docker_socket_path" {
  type        = string
  description = "Host path to docker socket"
  default     = "/var/run/docker.sock"
}

variable "docker_gid" {
  type        = number
  default     = 969
  description = "GID with write permission to docker_socket_path"
}
