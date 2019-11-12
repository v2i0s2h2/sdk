#!/usr/bin/env bats

load utils/_

setup() {
    # We want to work from a temporary directory, different for every test.
    cd $(mktemp -d -t dfx-e2e-XXXXXXXX)
    export RUST_BACKTRACE=1

    dfx_new
}

teardown() {
    # Verify that processes are not running (yet).
    ! ( ps | grep \ dfx\ start )
}

@test "install fails if no argument is provided" {
    assert_command_fail dfx canister install
    assert_match "required arguments were not provided"
    assert_match "--all"
}