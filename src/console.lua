---@type ProfilingNs
local ns = select(2, ...)

local function enableScriptProfiling()
  if ns.isScriptProfilingEnabled() then
    print("scriptProfile is already enabled")
    return
  end
  C_CVar.SetCVar("scriptProfile", 1)
  C_UI.Reload()
end

local function disableScriptProfiling()
  if not ns.isScriptProfilingEnabled() then
    print("scriptProfile is already disabled")
    return
  end
  C_CVar.SetCVar("scriptProfile", 0)
  C_UI.Reload()
end

local function printCommand(cmd, description)
  print(string.format("/p2 %-10s%s", cmd, description))
end

local function printHelp()
  print("Profiling2 automatically starts and stops profiling with your raid and dungeon encounters as long as script profiling is enabled.\nIf you are unsure if it is enabled, use the `/p2 enable` command.")
  print("Profiling2 Command Usage")
  printCommand("help", "Print this message")
  printCommand("status", "Print profiling status information")
  printCommand("enable", "Enable script profiling and reload UI.")
  printCommand("disable", "Disable script profiling and reload UI. This will also disable Profiling2's profiling hooks.")
  printCommand("teststart", "Start a test profiling session.")
  printCommand("teststop", "Stop a test profiling session.")
end

local function handler(msg)
  local cmd, rest = msg:match("^(%S*)%s*(.-)$")
  if cmd == "teststart" then
    ns.start()
  elseif cmd == "teststop" then
    ns.stop()
  elseif cmd == "enable" then
    enableScriptProfiling()
  elseif cmd == "disable" then
    disableScriptProfiling()
  elseif cmd == "status" then
    ns.printStatus()
  elseif cmd == "help" then
    printHelp()
  else
    print('|cffff0000Unknown command:|r ' .. cmd)
    printHelp()
  end
end

RegisterNewSlashCommand(handler, "profiling2", "p2")
