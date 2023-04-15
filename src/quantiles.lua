---This file contains an implementation of the extended P2 Quantile Estimator ported from https://aakinshin.net/posts/ex-p2-quantile-estimator/
---Because it is a port of C# code, it is 0-based internally, while the external interface remains 1-based
---Note that this appears to overestimate low quantiles, but median-to-high quantiles work fine

---@type ProfilingNs
local addonNs = select(2, ...)

local INITIAL_STEP = 0.1

local targetQuantiles = {
  0.5,
  0.75,
  0.95,
  0.99
}

-- not going full arena, but we are gonna use a single table for the values. these index into it
local OBS = 1
local STEP = 2
-- number of stored values per quantile
local WIDTH = 2

---@class QuantileEstimator
---@field private data number[]
---@field private count number
local baseEstimator = {}

local estimatorMeta = {
  __index = baseEstimator
}

---@return QuantileEstimator
local function newEstimator()
  local result = {
    data = {},
    count = 0,
  }

  setmetatable(result, estimatorMeta)

  return result
end

local function trueUpdate(self, value)
  for i = 1, #targetQuantiles do
    local p = targetQuantiles[i]
    local offset = (i - 1) * WIDTH
    local x = self.data[offset + OBS]
    local step = self.data[offset + STEP]
    if x > value then
      self.data[offset + OBS] = x - step * (1.0 - p)
      if x - value < step then
        self.data[offset + STEP] = step / 2
      end
    elseif x < value then
      self.data[offset + OBS] = x + step * p
      if value - x < step then
        self.data[offset + STEP] = step / 2
      end
    end
  end
  self.count = self.count + 1
end

---@private
---@param value number
function baseEstimator:initialize(value)
  for _, p in ipairs(targetQuantiles) do
    table.insert(self.data, value)
    table.insert(self.data, math.max(math.abs(value * p), INITIAL_STEP))
  end
  self.update = trueUpdate
end

---@param value number
function baseEstimator:update(value)
  self:initialize(value)
  self.count = self.count + 1
end

function baseEstimator:enoughData()
  -- no real theoretical justification for 50, just needs enough time to converge
  return self.count >= 50
end

---@param index number
---@return number|nil
function baseEstimator:get(index)
  if not self:enoughData() then
    return nil
  end

  return self.data[(index - 1) * WIDTH + OBS]
end

---@return table<string, number>|nil
function baseEstimator:quantiles()
  if not self:enoughData() then
    return nil
  end

  local result = {}
  for i, p in ipairs(targetQuantiles) do
    result[tostring(p)] = self:get(i)
  end
  return result
end

function baseEstimator:sample_count()
  return self.count
end

function baseEstimator:reset()
  self.count = 0
  self.update = baseEstimator.update
  for i = 1,#self.data do
    self.data[i] = nil
  end
end

if type(addonNs) == 'table' then
  ---@class QuantileNs
  local quant = {
    new = newEstimator
  }

  addonNs.quantile = quant
end

return newEstimator
