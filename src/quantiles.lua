---This file contains an implementation of the extended P2 Quantile Estimator ported from https://aakinshin.net/posts/ex-p2-quantile-estimator/
---Because it is a port of C# code, it is 0-based internally, while the external interface remains 1-based
---Note that this appears to overestimate low quantiles, but median-to-high quantiles work fine

---@type ProfilingNs
local addonNs = select(2, ...)

local M = 3
local targetQuantiles = {
  [0] = 0.5,
  [1] = 0.75,
  [2] = 0.95
}

---@class QuantileEstimator
---@field private markerCount number
---@field private count number
---@field private n number[]
---@field private ns number[]
---@field private q number[]
local baseEstimator = {}

local estimatorMeta = {
  __index = baseEstimator
}

---@return QuantileEstimator
local function newEstimator()
  local markerCount = 2 * M + 3
  local n, ns_, q = {}, {}, {}
  for i = 0,markerCount - 1 do
    n[i] = 0
    ns_[i] = 0
    q[i] = 0
  end
  local result = {
    markerCount = markerCount,
    n = n,
    ns = ns_,
    q = q,
    count = 0
  }
  setmetatable(result, estimatorMeta)
  return result
end

---@private
---@param maxIndex number
function baseEstimator:updateNs(maxIndex)
  self.ns[0] = 0
  for i = 0, M - 1 do
    self.ns[i * 2 + 2] = maxIndex * targetQuantiles[i]
  end
  self.ns[self.markerCount - 1] = maxIndex

  self.ns[1] = maxIndex * targetQuantiles[1] / 2.0
  for i = 1,M - 1 do
    self.ns[2 * i + 1] = maxIndex * (targetQuantiles[i - 1] + targetQuantiles[i]) / 2.0
  end
  self.ns[self.markerCount - 2] = maxIndex * (1 + targetQuantiles[M - 1]) / 2.0
end

---@private
---@param i number 
---@param d number
---@return number
function baseEstimator:parabolic(i, d)
  return self.q[i] + d / (self.n[i + 1] - self.n[i - 1]) * (
    (self.n[i] - self.n[i - 1] + d) * (self.q[i + 1] - self.q[i]) / (self.n[i + 1] - self.n[i]) +
    (self.n[i + 1] - self.n[i] - d) * (self.q[i] - self.q[i - 1]) / (self.n[i] - self.n[i - 1])
  )
end

---@private
---@param i number
---@param d number
---@return number
function baseEstimator:linear(i, d)
  return self.q[i] + d * (self.q[i + d] - self.q[i]) / (self.n[i + d] - self.n[i])
end

---@private
---@param i number
function baseEstimator:adjust(i)
  local d = self.ns[i] - self.n[i]
  if (d >= 1 and self.n[i + 1] - self.n[i] > 1) or (d <= -1 and self.n[i - 1] - self.n[i] < -1) then
    local dSig
    if d == 0 then
      dSig = 0
    elseif d > 0 then
      dSig = 1
    else
      dSig = -1
    end
    local qs = self:parabolic(i, dSig)

    if self.q[i - 1] < qs and qs < self.q[i + 1] then
      self.q[i] = qs
    else
      self.q[i] = self:linear(i, dSig)
    end
    self.n[i] = self.n[i] + dSig
  end
end

local function round(number)
  local floor = math.floor(number + .5)
  if floor == math.floor(number) then
    return floor
  else
    return math.ceil(number)
  end
end

---@param value number
function baseEstimator:update(value)
  -- handle the first few numbers
  if self.count < self.markerCount then
    self.q[self.count] = value
    self.count = self.count + 1
    if self.count == self.markerCount then
      -- TODO: convert to 1-based arrays
      -- table.sort doesn't handle 0-indexed tables. this only happens once so its probably fine
      -- shift the contents forward to be [1, markerCount] instead of [0, markerCount - 1]
      for i = self.markerCount,1,-1 do
        self.q[i] = self.q[i-1]
      end
      table.sort(self.q)
      -- shift the contents back to be [0, markerCount - 1]
      for i = 0, self.markerCount - 1 do
        self.q[1] = self.q[i+1]
      end
      self.q[self.markerCount] = nil
      self:updateNs(self.markerCount - 1)
      for i = 0, self.markerCount - 1 do
        self.n[i] = round(self.ns[i])
      end
      for i = 0, self.markerCount - 1 do
        self.ns[i] = self.q[i]
      end
      for i = 0, self.markerCount - 1 do
        self.q[i] = self.ns[self.n[i]]
        assert(self.q[i] ~= nil, 'expected index i to be non-nil ' .. i .. ' ' .. self.n[i])
      end
      self:updateNs(self.markerCount - 1)
    end
    return
  end

  -- we have > markerCount numbers seen so far
  -- find and update the right quantile

  local k = -1
  if value < self.q[0] then
    self.q[0] = value
    k = 0
  else
    for i = 1, self.markerCount - 1 do
      if value < self.q[i] then
        k = i - 1
        break
      end
    end

    if k == -1 then
      self.q[self.markerCount - 1] = value
      k = self.markerCount - 2
    end
  end

  for i = k + 1, self.markerCount - 1 do
    self.n[i] = self.n[i] + 1
  end
  self:updateNs(self.count)

  local leftI, rightI = 1, self.markerCount - 2
  while leftI <= rightI do
    local i
    if math.abs(self.ns[leftI] / self.count - 0.5) <= math.abs(self.ns[rightI] / self.count - 0.5) then
      leftI = leftI + 1
      i = leftI
    else
      rightI = rightI - 1
      i = rightI
    end
    self:adjust(i)
  end

  self.count = self.count + 1
end

---@param index number The index of the quantile to retrieve. See `targetQuantiles`
---@return number|nil Returns nil if there are too few data points to get quantiles. Use the `top5` field instead in such cases
function baseEstimator:get(index)
  if self.count <= self.markerCount then
    return nil
  end

  return self.q[2 * index]
end

---@return number[]|nil
function baseEstimator:quantiles()
  if self.count <= self.markerCount then
    return nil
  end

  local result = {}
  for i = 1, M do
    result[tostring(targetQuantiles[i - 1])] = self:get(i)
  end
  return result
end

---@return number
function baseEstimator:sample_count()
  return self.count
end

function baseEstimator:reset()
  self.count = 0
end

if type(addonNs) == 'table' then
  ---@class QuantileNs
  local quant = {
    new = newEstimator
  }

  addonNs.quantile = quant
end

return newEstimator
