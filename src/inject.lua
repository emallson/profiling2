---This module contains injected profiling2 trackers for some popular (and problematic) addons, like
---Plater and WeakAuras2.
---
---If you're an addon author that wants to integrate Profiling2 into your addon, use
---`LibStub("Profiling2")` instead.

---@type ProfilingNs
local ns = select(2, ...)

local LibDeflate = LibStub("LibDeflate")

local function injectWA()
  if WeakAuras then
    ---@type function
    local origLoadFunction = WeakAuras.LoadFunction

    local trackers = {}

    function WeakAuras.LoadFunction(contents)
      local fn = origLoadFunction(contents)

      if fn == nil then
        return nil
      end

      local registrationComplete = false

      local triggerKey = LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(contents))

      local wrapped
      local outer = function(...)
        if not registrationComplete then
          local env = getfenv(fn).aura_env
          local id = env and env.id or 'Unknown'

          -- this guards against repeat LoadFunction calls
          -- we also don't necessarily have aura_env.id yet when the LoadFunction call runs
          local path = '@WeakAuras/Auras/' .. id .. '/dec:' .. triggerKey .. ':CustomFn'

          if trackers[path] == nil then
            trackers[path] = ns.tracker.getScriptTracker()
          end

          local tracker = trackers[path]
          wrapped = ns.core.buildWrapper(tracker, fn)
          ns.core.registerExternalFunction(path, wrapped, tracker)
          registrationComplete = true
        end

        return wrapped(...)
      end

      return outer
    end
  end
end

---Track all methods that are present on table, excluding keys inherited from its metatable.
---If you want to track a metatable's __index, use this on the __index directly.
---@see Profiling2.trackedFunction
---@param table table
---@param tableKey string
---@return table
local function trackAllMethods(table, tableKey)
  for methodName, _ in pairs(table) do
    local method = rawget(table, methodName)
    if method ~= nil and type(method) == "function" then
      local tracker = ns.tracker.getScriptTracker(ns.tracker.DependentType.Dependent)
      local key = tableKey .. ':' .. methodName
      table[methodName] = ns.core.buildWrapper(tracker, method)
      ns.core.registerExternalFunction(key, table[methodName], tracker)
    end
  end
  return table
end

local function injectPlater()
  ---@type table
  local Plater = _G["Plater"]
  if Plater then
    local trackers = {}

    -- Plater uses a structured chunkName that allows us to reverse it
    local function parseChunkName(chunkname)
      local _, _, scriptType, scriptName = string.find(chunkname, '^(.+) for (.+)$')
      return scriptType, scriptName
    end

    local function wrappedLoadString(baseKey)
      return function(text, chunkname)
        local outer, err = loadstring(text, chunkname)
        if outer ~= nil then
          --- find the tracker to use. re-use the tracker in case of recompilation (shouldn't happen
          --mid-combat, but...)
          if trackers[chunkname] == nil then
            trackers[chunkname] = ns.tracker.getScriptTracker()
          end
          local tracker = trackers[chunkname]

          local result = outer()

          local wrapper = ns.core.buildWrapper(tracker, result)
          local scriptType, scriptName = parseChunkName(chunkname)
          scriptName = LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(scriptName))
          local key = baseKey .. '/dec:' .. scriptName .. ':' .. scriptType
          ns.core.registerExternalFunction(key, wrapper, tracker)

          local function rewrapped()
            return wrapper
          end
          return rewrapped, err
        else
          return outer, err
        end
      end
    end

    local scriptEnv = {
      loadstring = wrappedLoadString('@Plater/Scripts'),
    }
    setmetatable(scriptEnv, { __index = _G })
    local hookEnv = {
      loadstring = wrappedLoadString('@Plater/Hooks'),
    }
    setmetatable(hookEnv, { __index = _G })

    setfenv(Plater.CompileScript, scriptEnv)
    setfenv(Plater.CompileHook, hookEnv)

    trackAllMethods(Plater, '@Plater/Core')
  end
end

local function injectVuhdo()
  local vuhdoBaseKey = '@VuhDo/GlobalMethods'
  local function isVuhdoFunction(key, value)
    if type(value) ~= 'function' then return false end
    return key:match("^VUHDO") ~= nil or key:match("^VuhDo") ~= nil
  end
  for fname, value in pairs(_G) do
    if isVuhdoFunction(fname, value) then
      local tracker = ns.tracker.getScriptTracker(ns.tracker.DependentType.Dependent)
      local key = vuhdoBaseKey .. ':' .. fname
      local newValue = ns.core.buildWrapper(tracker, value)
      _G[fname] = newValue
      -- print(key, value, _G[key])
      ns.core.registerExternalFunction(key, _G[fname], tracker)
    end
  end
  VUHDO_loadVariables()
  VUHDO_initAllBurstCaches()
end


if ns.isScriptProfilingEnabled() then
  local listener = CreateFrame('Frame', 'Profiling2Inject')
  listener:RegisterEvent("ADDON_LOADED")

  listener:SetScript("OnEvent", function(frame, eventName, addonName)
    if addonName == 'WeakAuras' then
      injectWA()
    elseif addonName == 'Plater' then
      injectPlater()
    elseif addonName == 'VuhDo' then
      injectVuhdo()
    end
  end)
end
