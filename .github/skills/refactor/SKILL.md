---
name: refactor
description: 'Surgical code refactoring to improve maintainability without changing behavior. Covers extracting functions, reducing cognitive complexity, renaming variables, breaking down god functions, improving type safety, eliminating code smells, and applying design patterns. Use for: refactor this, clean up code, simplify complex method, reduce cognitive complexity, extract helper methods.'
license: MIT
---

# Refactor

## Overview

Improve code structure and readability without changing external behavior. Refactoring is gradual evolution, not revolution. Use this for improving existing code, not rewriting from scratch.

## When to Use

Use this skill when:

- Code is hard to understand or maintain
- Functions/classes are too large or too complex
- A method's cognitive complexity needs reducing
- Code smells need addressing
- Adding features is difficult due to code structure
- User asks "clean up this code", "refactor this", "improve this", "simplify this method"

---

## Refactoring Principles

### The Golden Rules

1. **Behavior is preserved** - Refactoring doesn't change what the code does, only how
2. **Small steps** - Make tiny changes, test after each
3. **Version control is your friend** - Commit before and after each safe state
4. **Tests are essential** - Without tests, you're not refactoring, you're editing
5. **One thing at a time** - Don't mix refactoring with feature changes

### When NOT to Refactor

```
- Code that works and won't change again (if it ain't broke...)
- Critical production code without tests (add tests first)
- When you're under a tight deadline
- "Just because" - need a clear purpose
```

---

## Common Code Smells

Recognize these 10 smells and apply the corresponding fix. See [references/code-smells.md](./references/code-smells.md) for detailed before/after examples of each.

| # | Smell | Fix |
|---|-------|-----|
| 1 | Long Method/Function | Break into focused functions |
| 2 | Duplicated Code | Extract common logic |
| 3 | Large Class/Module | Single responsibility per class |
| 4 | Long Parameter List | Group into parameter object or builder |
| 5 | Feature Envy | Move logic to the object that owns the data |
| 6 | Primitive Obsession | Use domain types |
| 7 | Magic Numbers/Strings | Named constants |
| 8 | Nested Conditionals | Guard clauses / early returns |
| 9 | Dead Code | Remove it (git history has it) |
| 10 | Inappropriate Intimacy | Ask, don't tell — use encapsulation |

---

## Reducing Method Complexity

When a method has high cognitive complexity, reduce it by extracting logic into focused helper methods.

### 1. Identify Complexity Sources

- Nested conditional statements (if inside if inside if)
- Multiple if-else or switch chains
- Repeated code blocks within the method
- Multiple loops with embedded conditions
- Complex boolean expressions

### 2. Extract Focused Helper Methods

- Each helper should have a **single, clear responsibility**
- Extract validation into separate `validate*` methods
- Extract type-specific or case-specific logic into handler methods
- Create utility methods for common operations
- Use appropriate access levels (static, private, async)

### 3. Simplify the Main Method

- Reduce nesting depth with guard clauses and early returns
- Replace massive if-else chains with smaller orchestrated calls
- Ensure the main method reads as a **high-level flow**

```diff
# Before: Deep nesting, high complexity
- function processOrder(order) {
-   if (order) {
-     if (order.user) {
-       if (order.user.isActive) {
-         if (order.total > 0) {
-           // ... 30 lines of processing
-         }
-       }
-     }
-   }
- }

# After: Guard clauses + extracted helpers
+ function processOrder(order) {
+   if (!order) return { error: 'No order' };
+   if (!order.user) return { error: 'No user' };
+   if (!order.user.isActive) return { error: 'User inactive' };
+   if (order.total <= 0) return { error: 'Invalid total' };
+   return executeOrderProcessing(order);
+ }
```

### 4. Best Practices

- Make helper methods **static** when they don't need instance state
- Use null checks and guard clauses early
- Consider using tuples for multiple return values
- Group related helper methods together
- Extract helper methods **before** refactoring the main flow
- Use meaningful names that describe the extracted responsibility

---

## Introducing Type Safety

### From Untyped to Typed

```diff
# Before: No types
- function calculateDiscount(user, total, membership, date) {
-   if (membership === 'gold' && date.getDay() === 5) {
-     return total * 0.25;
-   }
-   if (membership === 'gold') return total * 0.2;
-   return total * 0.1;
- }

# After: Full type safety
+ type Membership = 'bronze' | 'silver' | 'gold';
+
+ interface User {
+   id: string;
+   name: string;
+   membership: Membership;
+ }
+
+ interface DiscountResult {
+   original: number;
+   discount: number;
+   final: number;
+   rate: number;
+ }
+
+ function calculateDiscount(
+   user: User,
+   total: number,
+   date: Date = new Date()
+ ): DiscountResult {
+   if (total < 0) throw new Error('Total cannot be negative');
+
+   let rate = 0.1; // Default bronze
+
+   if (user.membership === 'gold' && date.getDay() === 5) {
+     rate = 0.25; // Friday bonus for gold
+   } else if (user.membership === 'gold') {
+     rate = 0.2;
+   } else if (user.membership === 'silver') {
+     rate = 0.15;
+   }
+
+   const discount = total * rate;
+
+   return {
+     original: total,
+     discount,
+     final: total - discount,
+     rate
+   };
+ }
```

---

## Design Patterns for Refactoring

Use patterns to replace complex conditional logic with clean, extensible structures. See [references/design-patterns.md](./references/design-patterns.md) for full before/after examples.

| Pattern | When to Use |
|---------|-------------|
| Strategy | Replace conditional branching with interchangeable strategy objects |
| Chain of Responsibility | Replace nested/sequential validation with composable validator chains |

---

## Safe Refactoring Process

```
1. PREPARE
   - Ensure tests exist (write them if missing)
   - Commit current state
   - Create feature branch

2. IDENTIFY
   - Find the code smell or complexity to address
   - Understand what the code does
   - Plan the refactoring

3. REFACTOR (small steps)
   - Make one small change
   - Run tests
   - Commit if tests pass
   - Repeat

4. VERIFY
   - All tests pass
   - Manual testing if needed
   - Performance unchanged or improved

5. CLEAN UP
   - Update comments
   - Update documentation
   - Final commit
```

---

## Testing and Validation

**After completing any refactoring, you MUST:**

1. **Run all existing tests** related to the refactored code
2. **Explicitly verify test results show "failed=0"**
   - Never assume tests passed — examine the actual test output
   - Search for the summary line containing pass/fail counts
   - If test output is in a file, read the entire file to verify the failure count
   - Running tests is NOT the same as verifying tests passed
3. **Preserve behavior** — maintain the same input/output, error handling, and exception types

---

## Refactoring Checklist

### Code Quality

- [ ] Functions are small (< 50 lines)
- [ ] Functions do one thing
- [ ] No duplicated code
- [ ] Descriptive names (variables, functions, classes)
- [ ] No magic numbers/strings
- [ ] Dead code removed

### Structure

- [ ] Related code is together
- [ ] Clear module boundaries
- [ ] Dependencies flow in one direction
- [ ] No circular dependencies

### Type Safety

- [ ] Types defined for all public APIs
- [ ] No `any` types without justification
- [ ] Nullable types explicitly marked

### Testing

- [ ] Refactored code is tested
- [ ] Tests cover edge cases
- [ ] All tests pass (verified, not assumed)

---

## Common Refactoring Operations

| Operation                                     | Description                           |
| --------------------------------------------- | ------------------------------------- |
| Extract Method                                | Turn code fragment into method        |
| Extract Class                                 | Move behavior to new class            |
| Extract Interface                             | Create interface from implementation  |
| Inline Method                                 | Move method body back to caller       |
| Inline Class                                  | Move class behavior to caller         |
| Pull Up Method                                | Move method to superclass             |
| Push Down Method                              | Move method to subclass               |
| Rename Method/Variable                        | Improve clarity                       |
| Introduce Parameter Object                    | Group related parameters              |
| Replace Conditional with Polymorphism         | Use polymorphism instead of switch/if |
| Replace Magic Number with Constant            | Named constants                       |
| Decompose Conditional                         | Break complex conditions              |
| Consolidate Conditional                       | Combine duplicate conditions          |
| Replace Nested Conditional with Guard Clauses | Early returns                         |
| Introduce Null Object                         | Eliminate null checks                 |
| Replace Type Code with Class/Enum             | Strong typing                         |
| Replace Inheritance with Delegation           | Composition over inheritance          |
