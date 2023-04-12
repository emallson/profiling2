rockspec_format = "3.0"
package = "profiling2"
version = "dev-1"
source = {
   url = "*** please add URL for source tarball, zip or repository here ***"
}
description = {
   homepage = "*** please enter a project homepage ***",
   license = "bsd3"
}
build = {
   type = "builtin",
   modules = {
      heap = "src/heap.lua"
   }
}

dependencies = {
  "lua >= 5.1"
}

test_dependencies = {
  'busted',
  'inspect',
}

test = {
  type = "busted"
}
