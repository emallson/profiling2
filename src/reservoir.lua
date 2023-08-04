---@type ProfilingNs
local ns = select(2, ...)

---@class ReservoirSampler
---@field private data number[]
---@field private maxPoints number
---@field private W number
---@field private S number
local reservoir = {}

local reservoirMeta = {
  __index = reservoir,
}

---Get a random number on (0,1).
---`math.random` is on [0,1) which is a problem for math.log()
---@return number
local function safeRandom()
  local x
  while true do
    x = math.random()
    if x > 0 then return x end
  end
end

---@param maxPoints number
---@return ReservoirSampler
local function newReservoir(maxPoints)
  local result = {
    data = {},
    maxPoints = maxPoints,
    W = 1,
    S = 0,
    index = 0,
  }

  setmetatable(result, reservoirMeta)

  result:generateW()
  result:generateS()

  return result
end

---@private
function reservoir:generateW()
  self.W = self.W * math.exp(math.log(safeRandom()) / self.maxPoints)
end

---@private
function reservoir:generateS()
  self.S = self.S + 1 + math.floor(math.log(safeRandom()) / math.log(1.0 - self.W))
end

---Returns the number of *stored* samples. The number of 
---observed samples is not tracked.
---@return number
function reservoir:sample_count()
  return #self.data
end

---@param sample number
function reservoir:update(sample)
  if #self.data < self.maxPoints then
    table.insert(self.data, sample)
  else
    self.index = self.index + 1
    if self.index >= self.S then
      local replace = math.random(1, #self.data)
      self.data[replace] = sample
      self:generateW()
      self:generateS()
    end
  end
end

---@return number[]
function reservoir:samples()
  local result = {}
  for i = 1,#self.data do
    result[i] = self.data[i]
  end
  return result
end

function reservoir:reset()
  for i = 1,#self.data do
    self.data[i] = nil
  end

  self:generateW()
  self:generateS()
end

if type(ns) == 'table' then
  ---@class ReservoirNs
  local module = {
    new = newReservoir
  }

  ns.reservoir = module
end

return newReservoir
