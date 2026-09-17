// Persistent one-rank adaptation of PETSc's ksp tutorial ex1.
// Ordinary globals and PetscCall return semantics, with no driver instrumentation.
#include <petscksp.h>
Mat A = NULL;
Vec x = NULL, b = NULL, residual_vector = NULL;
KSP ksp = NULL;
PC pc = NULL;
PetscInt problem_size = 12;
PetscErrorCode ierr;
PetscErrorCode build_problem(void)
{
  PetscFunctionBeginUser;
  PetscCall(MatCreateSeqAIJ(PETSC_COMM_SELF, problem_size, problem_size, 3, NULL, &A));
  for (PetscInt row = 0; row < problem_size; ++row) {
    if (row > 0) PetscCall(MatSetValue(A, row, row - 1, -1.0, INSERT_VALUES));
    PetscCall(MatSetValue(A, row, row, 2.0, INSERT_VALUES));
    if (row + 1 < problem_size) PetscCall(MatSetValue(A, row, row + 1, -1.0, INSERT_VALUES));
  }
  PetscCall(MatAssemblyBegin(A, MAT_FINAL_ASSEMBLY));
  PetscCall(MatAssemblyEnd(A, MAT_FINAL_ASSEMBLY));
  PetscCall(MatSetOption(A, MAT_SPD, PETSC_TRUE));
  PetscCall(MatCreateVecs(A, &x, &b));
  PetscCall(VecDuplicate(b, &residual_vector));
  PetscCall(VecSet(b, 1.0));
  PetscCall(KSPCreate(PETSC_COMM_SELF, &ksp));
  PetscCall(KSPSetOperators(ksp, A, A));
  PetscCall(KSPSetType(ksp, KSPCG));
  PetscCall(KSPGetPC(ksp, &pc));
  PetscCall(PCSetType(pc, PCNONE));
  PetscCall(KSPSetTolerances(ksp, 1.e-12, 1.e-14, 1.e5, 100));
  PetscFunctionReturn(PETSC_SUCCESS);
}
PetscErrorCode solve_and_report(const char *label)
{
  PetscInt its;
  PetscReal residual;
  const PetscScalar *values;
  PetscFunctionBeginUser;
  PetscCall(KSPSolve(ksp, b, x));
  PetscCall(KSPGetIterationNumber(ksp, &its));
  PetscCall(MatMult(A, x, residual_vector));
  PetscCall(VecAXPY(residual_vector, -1.0, b));
  PetscCall(VecNorm(residual_vector, NORM_2, &residual));
  PetscCall(VecGetArrayRead(x, &values));
  printf("SOLVE %s its=%d residual=%.17g first=%.17g mid=%.17g last=%.17g A=%p KSP=%p\n",
    label, (int)its, (double)residual, (double)PetscRealPart(values[0]),
    (double)PetscRealPart(values[problem_size/2]), (double)PetscRealPart(values[problem_size-1]), (void*)A, (void*)ksp);
  PetscCall(VecRestoreArrayRead(x, &values));
  PetscFunctionReturn(PETSC_SUCCESS);
}
PetscErrorCode destroy_problem(void)
{
  PetscFunctionBeginUser;
  PetscCall(KSPDestroy(&ksp));
  pc = NULL;
  PetscCall(VecDestroy(&x));
  PetscCall(VecDestroy(&b));
  PetscCall(VecDestroy(&residual_vector));
  PetscCall(MatDestroy(&A));
  PetscFunctionReturn(PETSC_SUCCESS);
}
