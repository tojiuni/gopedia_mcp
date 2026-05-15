#!/usr/bin/env python3
"""Entry point for running Dagger pipelines from Woodpecker CI."""

import argparse
import os
import sys

import anyio
import dagger

REGISTRY = "artifacts.toji.homes"
IMAGE_NAME = "gopedia-mcp"


async def _build_and_push(client: dagger.Client, token: dagger.Secret, sha: str, version_tag: str | None = None) -> str:
    tag = sha[:7]
    container = (
        client.host()
        .directory(".")
        .docker_build(dockerfile="Dockerfile")
        .with_registry_auth(REGISTRY, "woodpecker", token)
    )

    sha_addr = f"{REGISTRY}/neunexus/{IMAGE_NAME}:{tag}"
    latest_addr = f"{REGISTRY}/neunexus/{IMAGE_NAME}:latest"
    sha_ref = await container.publish(sha_addr)
    await container.publish(latest_addr)
    if version_tag:
        ver_addr = f"{REGISTRY}/neunexus/{IMAGE_NAME}:{version_tag}"
        await container.publish(ver_addr)
        return f"✓ {IMAGE_NAME}: {sha_ref} (also tagged {version_tag})"
    return f"✓ {IMAGE_NAME}: {sha_ref}"


async def _validate(client: dagger.Client) -> str:
    await client.host().directory(".").docker_build(dockerfile="Dockerfile")
    return f"✓ {IMAGE_NAME}: build OK"


async def cmd_build(sha: str, token_val: str, version_tag: str | None = None) -> None:
    runner_host = os.getenv("DAGGER_RUNNER_HOST", "")
    if runner_host:
        os.environ["DAGGER_RUNNER_HOST"] = runner_host
        os.environ["_EXPERIMENTAL_DAGGER_RUNNER_HOST"] = runner_host
    async with dagger.Connection() as client:
        token = client.set_secret("registry_token", token_val)
        result = await _build_and_push(client, token, sha, version_tag=version_tag)
    print(result)


async def cmd_validate() -> None:
    runner_host = os.getenv("DAGGER_RUNNER_HOST", "")
    if runner_host:
        os.environ["DAGGER_RUNNER_HOST"] = runner_host
        os.environ["_EXPERIMENTAL_DAGGER_RUNNER_HOST"] = runner_host
    async with dagger.Connection() as client:
        result = await _validate(client)
    print(result)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build")
    p_build.add_argument("--sha", required=True)
    p_build.add_argument("--version-tag", default=None)

    sub.add_parser("validate")

    args = parser.parse_args()

    if args.cmd == "build":
        token_val = os.environ.get("REGISTRY_TOKEN", "")
        if not token_val:
            print("ERROR: REGISTRY_TOKEN not set", file=sys.stderr)
            sys.exit(1)
        anyio.run(cmd_build, args.sha, token_val, args.version_tag)

    elif args.cmd == "validate":
        anyio.run(cmd_validate)


if __name__ == "__main__":
    main()
